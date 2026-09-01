// ============================================================
// chat.js — GhostZap Secure Chat
// Lógica principal: polling, envio/recepção E2EE, UI dinâmica
// ============================================================

'use strict';

const TalkChat = (() => {

    // Estado global da aplicação
    const state = {
        currentUser:    null,   // {id, username, fingerprint}
        activeContact:  null,   // {id, username, publicKey, fingerprint}
        keyPair:        null,   // {publicKey, privateKey} — CryptoKey objects
        pollingTimer:   null,
        contacts:       [],
        conversations:  [],
        isTyping:       false,
        lastMessageId:  null,
        pendingUploads: new Map(),
        receivedMessageIds: new Set(), // Cache temporário para ignorar duplicatas até o ACK no servidor
        isFetching:     false,          // Trava para evitar polling sobreposto
    };

    // Cache de chaves públicas com TTL de 2 minutos
    const publicKeyCache = new Map(); // key => { cryptoKey, expiresAt }

    // Cache de avatares: userId => dataURL | null
    const avatarCache = new Map();

    // ─── Gerador de UUID para rastrear status de mensagens ───
    function generateMsgId() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        // Fallback manual
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    // --------------------------------------------------------
    // Inicialização
    // --------------------------------------------------------

    /**
     * Inicializa o chat após login bem-sucedido
     * @param {object} user dados do usuário autenticado
     */
    async function init(user) {
        state.currentUser = user;
        
        // Inicializar armazenamento (abre o IndexedDB v2)
        await TalkStorage.openDB();
        
        // Recuperar par de chaves do IndexedDB
        const storedKeys = await TalkStorage.getKeyPair(user.id);
        
        if (!storedKeys) {
            // Primeira vez neste dispositivo — gerar novas chaves E ATUALIZAR SERVIDOR
            await regenerateKeys(user);
        } else {
            state.keyPair = {
                publicKey:  storedKeys.publicKey,
                privateKey: storedKeys.privateKey,
            };
            
            // SEMPRE sincronizar chave pública com servidor a cada carregamento
            // Garante que o servidor tem a chave correta mesmo que uma versão
            // anterior tenha regenerado sem atualizar o servidor
            await syncPublicKeyToServer();
        }
        
        // Limpar mensagens expiradas na inicialização
        await TalkStorage.cleanExpiredMessages();
        
        // Carregar conversas do IndexedDB
        await loadConversations();
        
        // Carregar avatar próprio
        await loadMyAvatar();

        // Iniciar polling de mensagens
        startPolling();
        
        // Listener de visibilidade: envia ACKs pendentes e acorda polling imediatamente ao voltar
        setupVisibilityListener();

        // Solicitar permissão para notificações do sistema no primeiro toque/clique
        if ('Notification' in window && Notification.permission === 'default') {
            document.addEventListener('click', () => {
                if (Notification.permission === 'default') {
                    Notification.requestPermission();
                }
            }, { once: true });
        }

        // Limpar mensagens expiradas a cada minuto

        setInterval(() => TalkStorage.cleanExpiredMessages(), 60000);

        // Atualizar contadores de TTL a cada segundo
        setInterval(() => updateTTLCounters(), 1000);
        
        // Verificar se há contato pendente para auto-adicionar (Deep Link ?add=username)
        await processDeepLinkAdd();

        // Bônus de Desenvolvedor: 5 cliques no logo
        const logo = document.getElementById('site-logo');
        if (logo) {
            logo.addEventListener('click', () => TalkUI.handleLogoClick());
        }

        // Sincronizar créditos unificados no boot
        TalkUI.syncCredits();

        console.log('✅ GhostZap inicializado com E2EE ativo');
    }

    /**
     * Processa Deep Link ?add=username após login
     * Lê 'ghostzap_add_pending' do localStorage e abre conversa com o usuário
     */
    async function processDeepLinkAdd() {
        const pendingUsername = localStorage.getItem('ghostzap_add_pending');
        if (!pendingUsername) return;

        // Remover imediatamente para não processar 2x
        localStorage.removeItem('ghostzap_add_pending');

        try {
            const res  = await fetch(`api/users.php?username=${encodeURIComponent(pendingUsername)}`, { credentials: 'include' });
            if (!res.ok) return;
            const data = await res.json();
            if (!data.id || !data.username) return;

            // Guardar a chave pública e fingerprint e abrir conversa diretamente
            const msg = (TalkI18n.dictionary['notif_contact_added_link'] || '👋 Contato "{user}" adicionado via link!').replace('{user}', data.username);
            showNotification(msg, 'success');
            await openConversation({
                id:          String(data.id),
                username:    data.username,
                publicKey:   data.public_key || '',
                fingerprint: data.fingerprint || '',
            });
        } catch (e) {
            console.warn('Deep link add falhou:', e.message);
        }
    }

    /**
     * Sincroniza chave pública local com o servidor (silencioso)
     * Chamada a cada init() para garantir consistência
     */
    async function syncPublicKeyToServer() {
        if (!state.keyPair?.publicKey) return;
        try {
            const publicKeyB64 = await TalkCrypto.exportPublicKey(state.keyPair.publicKey);
            const res = await fetch('api/updatekey.php', {
                method:      'POST',
                credentials: 'include',
                headers:     { 'Content-Type': 'application/json' },
                body:        JSON.stringify({ public_key: publicKeyB64 }),
            });
            if (res.ok) {
                const data = await res.json();
                if (data.fingerprint && state.currentUser) {
                    state.currentUser.fingerprint = data.fingerprint;
                    const fpEl = document.getElementById('my-fingerprint');
                    if (fpEl) fpEl.textContent = '🔑 ' + data.fingerprint;
                }
                console.log('🔑 Chave pública sincronizada com servidor');
            }
        } catch (e) {
            console.warn('Sync de chave pública falhou (sem internet?):', e.message);
        }
    }

    // ─────────────────────────────────────────────────────────
    // Avatares
    // ─────────────────────────────────────────────────────────

    /** Carrega e exibe o avatar do usuário logado */
    async function loadMyAvatar() {
        try {
            const res  = await fetch('api/avatar.php', { credentials: 'include' });
            const data = await res.json();
            if (data.avatar) {
                avatarCache.set(String(state.currentUser.id), data.avatar);
                applyAvatarToEl(document.getElementById('my-avatar'), data.avatar);
            }
        } catch (e) { /* sem avatar — mantém inicial */ }
    }

    /** Carrega avatar de um contato (com cache) */
    async function loadContactAvatar(userId) {
        const key = String(userId);
        if (avatarCache.has(key)) return avatarCache.get(key);

        try {
            const res  = await fetch(`api/avatar.php?id=${key}`, { credentials: 'include' });
            const data = await res.json();
            const url  = data.avatar || null;
            avatarCache.set(key, url);
            return url;
        } catch (e) {
            avatarCache.set(key, null);
            return null;
        }
    }

    /** Aplica avatar a um elemento DOM (img ou letter-div) */
    function applyAvatarToEl(el, dataUrl) {
        if (!el) return;
        if (dataUrl) {
            el.style.backgroundImage = `url('${dataUrl}')`;
            el.style.backgroundSize  = 'cover';
            el.style.backgroundPosition = 'center';
            el.dataset.hasAvatar = 'true';
            el.textContent = ''; // remove a letra
        }
    }

    /** Redimensiona imagem para 128×128 e retorna dataURL WebP */
    function resizeAvatarImage(file) {
        return new Promise((resolve, reject) => {
            const img    = new Image();
            const reader = new FileReader();

            reader.onload = (e) => { img.src = e.target.result; };
            reader.onerror = reject;

            img.onload = () => {
                const SIZE   = 128;
                const canvas = document.createElement('canvas');
                canvas.width  = SIZE;
                canvas.height = SIZE;

                const ctx = canvas.getContext('2d');

                // Recorte centralizado (cover)
                const scale = Math.max(SIZE / img.width, SIZE / img.height);
                const sw    = SIZE / scale;
                const sh    = SIZE / scale;
                const sx    = (img.width - sw) / 2;
                const sy    = (img.height - sh) / 2;

                ctx.drawImage(img, sx, sy, sw, sh, 0, 0, SIZE, SIZE);
                resolve(canvas.toDataURL('image/webp', 0.82));
            };

            img.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    /** Upload de novo avatar */
    async function uploadAvatar(file) {
        try {
            const dataUrl = await resizeAvatarImage(file);

            const res = await fetch('api/avatar.php', {
                method:      'POST',
                credentials: 'include',
                headers:     { 'Content-Type': 'application/json' },
                body:        JSON.stringify({ avatar: dataUrl }),
            });

            if (!res.ok) throw new Error('Servidor recusou avatar');

            // Atualizar cache e UI própria
            avatarCache.set(String(state.currentUser.id), dataUrl);
            applyAvatarToEl(document.getElementById('my-avatar'), dataUrl);

            showNotification(TalkI18n.dictionary['notif_success_photo'] || '✅ Foto de perfil atualizada!', 'success');
        } catch (err) {
            const msg = (TalkI18n.dictionary['notif_error_photo'] || '❌ Erro ao salvar foto: ') + err.message;
            showNotification(msg, 'error');
        }
    }

    /**
     * Regenera par de chaves (primeiro login no dispositivo)
     * IMPORTANTE: também atualiza a chave pública no servidor
     * para que novas mensagens sejam criptografadas com a chave correta
     */
    async function regenerateKeys(user) {
        try {
            showNotification(TalkI18n.dictionary['notif_keys_generating'] || '🔐 Gerando chaves criptográficas...', 'info');
            
            const keyPair    = await TalkCrypto.generateKeyPair();
            state.keyPair    = keyPair;
            
            // Salvar no IndexedDB (chave privada nunca sai daqui)
            await TalkStorage.saveKeyPair(user.id, keyPair.publicKey, keyPair.privateKey);
            
            // Exportar e atualizar chave pública no servidor
            // Sem isso, mensagens enviadas para este usuário usariam a chave antiga
            const publicKeyB64 = await TalkCrypto.exportPublicKey(keyPair.publicKey);
            
            const res = await fetch('api/updatekey.php', {
                method:      'POST',
                credentials: 'include',
                headers:     { 'Content-Type': 'application/json' },
                body:        JSON.stringify({ public_key: publicKeyB64 }),
            });
            
            if (res.ok) {
                const data = await res.json();
                // Atualizar fingerprint no perfil se disponível
                if (data.fingerprint && state.currentUser) {
                    state.currentUser.fingerprint = data.fingerprint;
                    const fpEl = document.getElementById('my-fingerprint');
                    if (fpEl) fpEl.textContent = '🔑 ' + data.fingerprint;
                }
                
                // AVISO CRÍTICO: Usuário pode ter mensagens ilegíveis se as chaves foram perdidas
                showNotification('✅ Novas chaves E2EE geradas!', 'success');
                alert(TalkI18n.dictionary['warning_keys_regenerated'] || 
                    "Sua chave de segurança foi reiniciada. \nMensagens enviadas enquanto você estava offline podem estar ilegíveis.");
            } else {
                // Chaves estão no IDB mas não no servidor — avisar user
                showNotification('⚠️ Chaves geradas localmente. Faça login novamente se mensagens não chegarem.', 'error');
            }
            
        } catch (err) {
            console.error('Erro ao gerar chaves:', err);
            showNotification('❌ Erro ao gerar chaves de segurança: ' + err.message, 'error');
        }
    }

    // --------------------------------------------------------
    // Polling de Mensagens
    // --------------------------------------------------------

    /**
     * Inicia polling a cada 2 segundos
     */
    function startPolling() {
        if (state.pollingTimer) clearInterval(state.pollingTimer);
        
        // Primeira busca imediata
        fetchPendingMessages();
        
        // Polling a cada 2 segundos
        state.pollingTimer = setInterval(fetchPendingMessages, 2000);
    }

    /**
     * Busca mensagens pendentes no servidor
     * O servidor retorna dados criptografados — nunca consegue ler
     */
    async function fetchPendingMessages() {
        if (state.isFetching) return;
        state.isFetching = true;

        try {
            const res  = await fetch('api/relay.php', { credentials: 'include' });
            
            if (!res.ok) {
                if (res.status === 401) {
                    stopPolling();
                    window.location.href = 'index.php';
                }
                return;
            }
            
            const data = await res.json();
            if (!data.messages?.length) return;
            
            const processedIds = [];

            for (const msg of data.messages) {
                // Se já processamos este ID nesta sessão, ignorar (esperando o ACK no servidor)
                if (state.receivedMessageIds.has(msg.id)) continue;
                
                // ACKs de status (delivered/read) — tratar separadamente
                try {
                    const envelope = JSON.parse(msg.payload);
                    if (envelope.type === 'ack') {
                        await processAck(envelope);
                        state.receivedMessageIds.add(msg.id);
                        processedIds.push(msg.id);
                        continue;
                    }
                } catch (e) {}

                const success = await processIncomingMessage(msg);
                if (success) {
                    state.receivedMessageIds.add(msg.id);
                    processedIds.push(msg.id);
                }
            }

            // Enviar confirmações de recebimento para o servidor apagar
            if (processedIds.length > 0) {
                await confirmMessageReceipt(processedIds);
            }
            
        } catch (err) {
            console.debug('Polling error:', err.message);
        } finally {
            state.isFetching = false;
        }
    }


    function stopPolling() {
        if (state.pollingTimer) {
            clearInterval(state.pollingTimer);
            state.pollingTimer = null;
        }
    }

    /**
     * Confirma o recebimento de mensagens ao servidor (ACK)
     * Isso permite que o servidor as delete com segurança da fila de espera
     * @param {number[]} ids lista de IDs numéricos do servidor (relay)
     */
    async function confirmMessageReceipt(ids) {
        if (!ids || ids.length === 0) return;
        try {
            await fetch('api/relay.php', {
                method:      'POST',
                credentials: 'include',
                headers:     { 'Content-Type': 'application/json' },
                body:        JSON.stringify({ action: 'delete_acks', ids: ids }),
            });
            if (ids.length > 0) {
                ids.forEach(id => state.receivedMessageIds.delete(id));
            }
        } catch (e) {
            console.warn('Falha ao enviar ACKs para o servidor:', e.message);
        }
    }

    // --------------------------------------------------------
    // Processamento de Mensagens Recebidas
    // --------------------------------------------------------

    /**
     * Descriptografa e processa mensagem recebida
     * @param {object} rawMsg mensagem do relay (payload criptografado)
     */
    async function processIncomingMessage(rawMsg) {
        const senderId   = String(rawMsg.from);
        const senderName = rawMsg.from_username;
        
        try {
            if (!state.keyPair?.privateKey) {
                console.warn('Chave privada não disponível ainda, pulando mensagem');
                return;
            }
            
            // Parsear envelope do payload
            let envelope;
            try {
                envelope = JSON.parse(rawMsg.payload);
            } catch (e) {
                console.error('Payload inválido do relay:', rawMsg);
                return;
            }
            
        // Buscar chave pública do remetente para cache
            try { await getPublicKey(senderId); } catch (e) { /* ignora — apenas para cache */ }
            
            // Descriptografar com nossa chave privada
            let content, type;
            let fileMetadata = null;
            
            try {
                if (envelope.type === 'text') {
                    const rawDecrypted = await TalkCrypto.decryptMessageText(envelope.data, state.keyPair.privateKey);
                    content = TalkCrypto.removeTrafficPadding(rawDecrypted);
                    type    = 'text';
                    
                } else if (envelope.type === 'image' || envelope.type === 'disappearing_image') {
                    const bytes = await TalkCrypto.decryptMessage(envelope.data, state.keyPair.privateKey);
                    const mimeType = TalkMedia.detectMimeType(bytes.buffer) || 'image/webp';
                    content     = TalkMedia.arrayBufferToDataUrl(bytes.buffer, mimeType);
                    type        = envelope.type;
                    
                } else if (envelope.type === 'file') {
                    const bytes = await TalkCrypto.decryptMessage(envelope.data, state.keyPair.privateKey);
                    const fileId = TalkMedia.generateFileId();
                    await TalkStorage.saveFile(fileId, bytes.buffer, {
                        name: envelope.fileName,
                        type: envelope.mimeType,
                        size: bytes.byteLength,
                    });
                    content      = envelope.fileName;
                    type         = 'file';
                    fileMetadata = {
                        fileId,
                        fileName: envelope.fileName,
                        mimeType: envelope.mimeType,
                        fileSize: bytes.byteLength,
                    };
                } else if (envelope.type === 'receipt') {
                    // MENSAGEM DE SISTEMA: Recibo de leitura/entrega
                    const rawData = await TalkCrypto.decryptMessage(envelope.data, state.keyPair.privateKey);
                    const receipt = JSON.parse(new TextDecoder().decode(rawData));
                    
                    if (receipt.msgId && receipt.status) {
                        await TalkStorage.updateMessageStatus(receipt.msgId, receipt.status);
                        
                        // Se estiver na conversa ativa, atualizar UI imediatamente
                        if (state.activeContact && String(state.activeContact.id) === senderId) {
                            const msgEl = document.querySelector(`[data-msg-uuid="${receipt.msgId}"]`);
                            if (msgEl) {
                                const statusContainer = msgEl.querySelector('.msg-status');
                                if (statusContainer) {
                                    statusContainer.innerHTML = TalkUI.getStatusHTML(receipt.status);
                                    statusContainer.className = `msg-status ${receipt.status}`;
                                }
                            }
                        }
                    }
                    return; // Interrompe o processamento: recibos não são salvos como mensagens visíveis
                } else {
                    console.warn('Tipo de mensagem desconhecido:', envelope.type);
                    return;
                }
                
            } catch (decryptErr) {
                console.warn('Erro de descriptografia:', decryptErr, rawMsg);
                
                // Invalidar cache da chave pública do remetente (pode ter mudado)
                publicKeyCache.delete(senderId);
                
                // Se for recibo/ack de sistema antigo, descarta silenciosamente do servidor
                if (envelope && (envelope.type === 'receipt' || envelope.type === 'ack')) {
                    return true;
                }

                // SALVAR MENSAGEM COM ERRO (melhor que descartar)
                const errorMsg = {
                    conversationId: TalkStorage.getConversationId(state.currentUser.id, senderId),
                    fromId:         senderId,
                    fromUsername:   senderName,
                    toId:           String(state.currentUser.id),
                    type:           'text',
                    content:        '🔒 Erro de descriptografia: Chave de segurança incompatível ou expirada. Mensagem ilegível.',
                    timestamp:      rawMsg.created_at || new Date().toISOString(),
                    status:         'sent',
                    isMine:         false,
                    isE2EError:     true // Flag para estilo especial
                };

                const msgId = await TalkStorage.saveMessage(errorMsg);
                
                // Se conversa ativa, mostrar bolha de erro
                if (state.activeContact && String(state.activeContact.id) === senderId) {
                    appendMessageToUI({ ...errorMsg, id: msgId });
                    scrollToBottom();
                }

                return true; // Confirma recebimento para o servidor apagar da fila e não repetir
            }
            
            // Enviar ACK de recebimento ao remetente (delivered)
            if (envelope.msgId) {
                sendAck(senderId, envelope.msgId, 'delivered');
            }

            // Calcular ID da conversa
            const convId = TalkStorage.getConversationId(state.currentUser.id, senderId);
            
            // Garantir que a conversa existe
            await TalkStorage.saveConversation(
                state.currentUser.id,
                senderId,
                senderName,
                '',  // publicKey do remetente — não necessário aqui
                ''
            );
            
            // Salvar mensagem no IndexedDB
            const msgData = {
                conversationId: convId,
                fromId:         senderId,
                fromUsername:   senderName,
                toId:           String(state.currentUser.id),
                type,
                content,
                msgId:          envelope.msgId || null,
                fileId:         fileMetadata ? fileMetadata.fileId   : null,
                fileName:       fileMetadata ? fileMetadata.fileName  : null,
                fileSize:       fileMetadata ? fileMetadata.fileSize  : null,
                timestamp:      rawMsg.created_at || new Date().toISOString(),
                status:         'received',
                isMine:         false,
                isTemporary:    envelope.ttl > 0,
                expiresAt:      envelope.ttl > 0
                    ? new Date(Date.now() + envelope.ttl * 1000).toISOString()
                    : null,
                viewed:         false,
            };
            
            const savedId = await TalkStorage.saveMessage(msgData);
            
            const isWindowHidden = document.hidden || document.visibilityState !== 'visible';
            
            // Tocar som e vibrar se a janela estiver minimizada ou for outro contato
            if (isWindowHidden || !state.activeContact || String(state.activeContact.id) !== senderId) {
                playMessageChime();
                if (navigator.vibrate) {
                    try { navigator.vibrate([120, 60, 120]); } catch (e) {}
                }
                showNativeSystemNotification(senderName);
            }

            // Atualizar UI se a conversa estiver aberta
            if (state.activeContact && String(state.activeContact.id) === senderId) {
                appendMessageToUI({ ...msgData, id: savedId });
                scrollToBottom();
                await TalkStorage.markConversationRead(convId);

                // ACK de leitura APENAS se o usuário está vendo a tela e NÃO é foto temporária
                if (envelope.msgId && !isWindowHidden && type !== 'disappearing_image') {
                    sendAck(senderId, envelope.msgId, 'read');
                } else if (envelope.msgId && type !== 'disappearing_image') {
                    // Guardar msgId para enviar o ACK quando o usuário voltar
                    pendingReadAcks.push({ toId: senderId, msgId: envelope.msgId });
                }
            } else {
                // Notificar na interface sobre nova mensagem (com click para abrir)
                showNotification(`💬 Nova mensagem de ${senderName}`, 'message', () => {
                    openConversation({
                        id:        senderId,
                        username:  senderName,
                        publicKey: '', // será buscado fresco ao abrir a conversa
                    });
                });
            }
            
            // Atualizar lista de conversas
            await loadConversations();
            return true;
            
        } catch (err) {
            console.error('Erro geral ao processar mensagem de', senderName, ':', err);
            return false;
        }
    }

    /**
     * Toca um som suave de notificação usando Web Audio API
     */
    function playMessageChime() {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            const ctx = new AudioCtx();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(784, ctx.currentTime); // G5
            osc.frequency.exponentialRampToValueAtTime(1046.5, ctx.currentTime + 0.12); // C6
            gain.gain.setValueAtTime(0.12, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.25);
        } catch (e) {}
    }

    /**
     * Dispara Notificação Nativa do Sistema Operacional (Android/iOS/PC)
     */
    function showNativeSystemNotification(senderName) {
        if (!('Notification' in window)) return;
        
        if (Notification.permission === 'granted') {
            try {
                new Notification('GhostZap 🔐', {
                    body: `Nova mensagem criptografada de @${senderName}`,
                    icon: 'icons/icon-192.png',
                    badge: 'icons/icon-192.png',
                    tag: 'ghostzap-msg-' + senderName,
                    renotify: true
                });
            } catch (e) {
                if (navigator.serviceWorker && navigator.serviceWorker.ready) {
                    navigator.serviceWorker.ready.then(reg => {
                        reg.showNotification('GhostZap 🔐', {
                            body: `Nova mensagem de @${senderName}`,
                            icon: 'icons/icon-192.png',
                            badge: 'icons/icon-192.png'
                        });
                    }).catch(() => {});
                }
            }
        } else if (Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }

    // --------------------------------------------------------
    // ACKs de status de mensagem (delivered / read)
    // --------------------------------------------------------

    // Fila de ACKs pendentes (recebidos enquanto tela estava bloqueada)
    const pendingReadAcks = [];

    /**
     * Envia ACKs pendentes e acorda polling imediatamente quando usuário volta ao app
     */
    function setupVisibilityListener() {
        async function handleResume() {
            if (document.hidden && document.visibilityState !== 'visible') return;

            // 1. Acordar polling IMEDIATAMENTE ao voltar à tela (celular desbloqueado)
            fetchPendingMessages();
            startPolling();

            // 2. Esvaziar fila de ACKs pendentes
            while (pendingReadAcks.length) {
                const ack = pendingReadAcks.shift();
                if (ack) sendAck(ack.toId, ack.msgId, 'read');
            }
        }

        document.addEventListener('visibilitychange', handleResume);
        window.addEventListener('focus', handleResume);
        window.addEventListener('pageshow', handleResume);
        window.addEventListener('online', handleResume);
    }

    /**
     * Envia ACK de status para o remetente via relay
     * O ACK contém apenas um UUID — sem conteúdo de mensagem
     */
    async function sendAck(toId, msgId, ackType) {
        try {
            await fetch('api/relay.php', {
                method:      'POST',
                credentials: 'include',
                headers:     { 'Content-Type': 'application/json' },
                body:        JSON.stringify({
                    to:      toId,
                    payload: JSON.stringify({ type: 'ack', msgId, ackType }),
                }),
            });
        } catch (e) {
            console.warn('ACK não enviado:', e.message);
        }
    }

    /**
     * Processa ACK recebido e atualiza status da mensagem na UI
     */
    async function processAck(ack) {
        const { msgId, ackType } = ack;
        if (!msgId || !ackType) return;

        const newStatus = ackType === 'read' ? 'read' : 'delivered';

        // Atualizar no IndexedDB
        await TalkStorage.updateMessageStatus(msgId, newStatus);

        // Atualizar na UI sem re-renderizar tudo
        const bubble = document.querySelector(`[data-msg-uuid="${msgId}"]`);
        if (bubble) {
            const statusEl = bubble.querySelector('.msg-status');
            if (statusEl) {
                statusEl.className = 'msg-status ' + newStatus;
                statusEl.innerHTML = newStatus === 'read'
                    ? '<span class="tick-double green">✓✓</span>'
                    : '<span class="tick-double gray">✓✓</span>';
            }
        }
    }

    // --------------------------------------------------------
    // Envio de Mensagens
    // --------------------------------------------------------

    /**
     * Envia mensagem de texto (criptografada)
     * @param {string} text conteúdo da mensagem
     * @param {number} ttl tempo de vida em segundos (0 = permanente)
     */
    async function sendTextMessage(text, ttl = 86400) {
        if (!state.activeContact || !text.trim()) return;
        
        const contact = state.activeContact;
        
        try {
            // Obter chave pública do destinatário
            const recipientPublicKey = await getPublicKey(contact.id);

            // Gerar UUID único para rastrear status desta mensagem
            const msgUUID = generateMsgId();
            
            // Montar envelope com metadados e Traffic Padding
            const envelope = {
                type:  'text',
                data:  await TalkCrypto.encryptMessage(TalkCrypto.addTrafficPadding(text.trim()), recipientPublicKey),
                ttl,
                msgId: msgUUID,  // UUID para ACK de delivered/read
            };
            
            // Enviar ao relay (servidor não lê o conteúdo)
            const res = await fetch('api/relay.php', {
                method:      'POST',
                credentials: 'include',
                headers:     { 'Content-Type': 'application/json' },
                body:        JSON.stringify({
                    to:      contact.id,
                    payload: JSON.stringify(envelope),
                }),
            });
            
            if (!res.ok) throw new Error('Falha ao enviar mensagem');
            
            // Salvar no IndexedDB local
            const convId  = TalkStorage.getConversationId(state.currentUser.id, contact.id);
            const msgData = {
                conversationId: convId,
                fromId:         String(state.currentUser.id),
                fromUsername:   state.currentUser.username,
                toId:           String(contact.id),
                type:           'text',
                content:        text.trim(),
                msgId:          msgUUID,
                timestamp:      new Date().toISOString(),
                status:         'sent',
                isMine:         true,
                isTemporary:    ttl > 0,
                expiresAt:      ttl > 0
                    ? new Date(Date.now() + ttl * 1000).toISOString()
                    : null,
            };
            
            const savedId = await TalkStorage.saveMessage(msgData);
            appendMessageToUI({ ...msgData, id: savedId });
            scrollToBottom();
            
        } catch (err) {
            console.error('Erro ao enviar mensagem:', err);
            showNotification(TalkI18n.dictionary['error_conn'] || '❌ Erro de conexão. Tente novamente.', 'error');
        }
    }

    /**
     * Envia imagem (convertida para WebP, criptografada)
     * @param {File} file arquivo de imagem
     * @param {boolean} disappearing se deve desaparecer após visualização (view-once)
     * @param {number} ttl tempo de vida em segundos (0 = permanente)
     */
    async function sendImage(file, disappearing = false, ttl = 86400) {
        if (!state.activeContact) return;
        
        try {
            updateUploadProgress(0, TalkI18n.dictionary['progress_processing'] || 'Processando...');
            
            // Converter para WebP
            const { blob, width, height, finalSize } = await TalkMedia.convertImageToWebP(file);
            
            updateUploadProgress(30, TalkI18n.dictionary['progress_encrypting'] || 'Criptografando arquivo...');
            
            // Converter blob para ArrayBuffer para criptografar
            const arrayBuffer = await TalkMedia.blobToArrayBuffer(blob);
            
            // Obter chave pública do destinatário
            const recipientPublicKey = await getPublicKey(state.activeContact.id);
            
            // Criptografar imagem
            const encrypted = await TalkCrypto.encryptMessage(
                new Uint8Array(arrayBuffer),
                recipientPublicKey
            );
            
            updateUploadProgress(70, TalkI18n.dictionary['progress_sending'] || 'Enviando...');
            
            // Gerar UUID único para rastrear status
            const msgUUID = generateMsgId();

            const envelope = {
                type: disappearing ? 'disappearing_image' : 'image',
                data: encrypted,
                ttl:  ttl,
                msgId: msgUUID,
            };
            
            const res = await fetch('api/relay.php', {
                method:      'POST',
                credentials: 'include',
                headers:     { 'Content-Type': 'application/json' },
                body:        JSON.stringify({
                    to:      state.activeContact.id,
                    payload: JSON.stringify(envelope),
                }),
            });
            
            if (!res.ok) throw new Error('Falha ao enviar imagem');
            
            updateUploadProgress(100, TalkI18n.dictionary['progress_sent'] || 'Enviado!');
            
            // Criar preview local para exibir
            const preview = await TalkMedia.createImagePreview(blob);
            
            const convId = TalkStorage.getConversationId(state.currentUser.id, state.activeContact.id);
            const msgData = {
                conversationId: convId,
                fromId:         String(state.currentUser.id),
                fromUsername:   state.currentUser.username,
                toId:           String(state.activeContact.id),
                type:           disappearing ? 'disappearing_image' : 'image',
                content:        preview,
                msgId:          msgUUID,
                timestamp:      new Date().toISOString(),
                status:         'sent',
                isMine:         true,
                isTemporary:    ttl > 0,
                expiresAt:      ttl > 0
                    ? new Date(Date.now() + ttl * 1000).toISOString()
                    : null,
                viewed:         false, // Inicia como não visualizada pelo destinatário
            };
            
            const msgId = await TalkStorage.saveMessage(msgData);
            appendMessageToUI({ ...msgData, id: msgId });
            scrollToBottom();
            
            setTimeout(() => hideProgress(), 2000);
            
        } catch (err) {
            console.error('Erro ao enviar imagem:', err);
            hideProgress();
            showNotification(`❌ ${err.message}`, 'error');
        }
    }

    /**
     * Envia recibo de status (E2EE) para o remetente
     * @param {string} toId ID do destinatário
     * @param {string} msgId UUID da mensagem (msgId do envelope)
     * @param {string} status 'delivered' ou 'read'
     */
    async function sendAck(toId, msgId, status) {
        if (!msgId || !toId) return;
        try {
            // Obter chave pública do destinatário (autor da mensagem original)
            const publicKey = await getPublicKey(toId);
            
            // Criar recibo
            const receipt = { msgId, status };
            const encrypted = await TalkCrypto.encryptMessage(
                new TextEncoder().encode(JSON.stringify(receipt)),
                publicKey
            );
            
            const envelope = {
                type: 'receipt',
                data: encrypted,
                msgId: generateMsgId(), // UUID do próprio recibo (não rastreado)
            };
            
            await fetch('api/relay.php', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    to:      toId,
                    payload: JSON.stringify(envelope),
                }),
            });
        } catch (e) {
            console.error('Erro ao enviar recibo E2EE:', e);
        }
    }

    /**
     * Envia arquivo (criptografado)
     * @param {File} file arquivo a enviar
     * @param {number} ttl tempo de vida em segundos
     */
    async function sendFile(file, ttl = 86400) {
        if (!state.activeContact) return;
        
        const validation = TalkMedia.validateFile(file);
        
        if (!validation.valid) {
            showNotification(`❌ ${validation.error}`, 'error');
            return;
        }
        
        if (validation.type === 'image') {
            return sendImage(file, false, ttl);
        }
        
        try {
            updateUploadProgress(0, TalkI18n.dictionary['progress_preparing'] || 'Preparando arquivo...');
            
            const arrayBuffer = await TalkMedia.blobToArrayBuffer(file);
            
            updateUploadProgress(30, TalkI18n.dictionary['progress_encrypting'] || 'Criptografando arquivo...');
            
            const recipientPublicKey = await getPublicKey(state.activeContact.id);
            const encrypted          = await TalkCrypto.encryptMessage(
                new Uint8Array(arrayBuffer),
                recipientPublicKey
            );
            
            updateUploadProgress(70, TalkI18n.dictionary['progress_sending'] || 'Enviando...');
            
            // Gerar UUID único para rastrear status
            const msgUUID = generateMsgId();

            const envelope = {
                type:     'file',
                data:     encrypted,
                fileName: file.name,
                mimeType: file.type,
                fileSize: file.size,
                ttl:      ttl,
                msgId:    msgUUID,
            };
            
            const res = await fetch('api/relay.php', {
                method:      'POST',
                credentials: 'include',
                headers:     { 'Content-Type': 'application/json' },
                body:        JSON.stringify({
                    to:      state.activeContact.id,
                    payload: JSON.stringify(envelope),
                }),
            });
            
            if (!res.ok) throw new Error('Falha ao enviar arquivo');
            
            updateUploadProgress(100, TalkI18n.dictionary['progress_sent'] || 'Enviado!');
            
            // Salvar arquivo localmente
            const fileId = TalkMedia.generateFileId();
            await TalkStorage.saveFile(fileId, arrayBuffer, {
                name: file.name,
                type: file.type,
                size: file.size,
            });
            
            const convId = TalkStorage.getConversationId(state.currentUser.id, state.activeContact.id);
            const msgData = {
                conversationId: convId,
                fromId:         String(state.currentUser.id),
                fromUsername:   state.currentUser.username,
                toId:           String(state.activeContact.id),
                type:           'file',
                content:        file.name,
                msgId:          msgUUID,
                fileId,
                fileName:       file.name,
                fileSize:       file.size,
                timestamp:      new Date().toISOString(),
                status:         'sent',
                isMine:         true,
                isTemporary:    ttl > 0,
                expiresAt:      ttl > 0
                    ? new Date(Date.now() + ttl * 1000).toISOString()
                    : null,
            };
            
            const msgId = await TalkStorage.saveMessage(msgData);
            appendMessageToUI({ ...msgData, id: msgId });
            scrollToBottom();
            
            setTimeout(() => hideProgress(), 2000);
            
        } catch (err) {
            console.error('Erro ao enviar arquivo:', err);
            hideProgress();
            showNotification(`❌ ${err.message}`, 'error');
        }
    }

    // --------------------------------------------------------
    // Gerenciamento de Chaves Públicas
    // --------------------------------------------------------

    /**
     * Obtém e faz cache da chave pública de um usuário
     * Cache expira em 2 minutos — garante que chaves atualizadas são detectadas
     * @param {string|number} userId
     * @returns {Promise<CryptoKey>}
     */
    async function getPublicKey(userId) {
        const key    = String(userId);
        const cached = publicKeyCache.get(key);
        const now    = Date.now();
        
        // Usar cache apenas se não expirou (TTL: 2 minutos)
        if (cached && cached.expiresAt > now) {
            return cached.cryptoKey;
        }
        
        // Buscar chave pública atualizada do servidor
        const res  = await fetch(`api/users.php?id=${key}`, { credentials: 'include' });
        const data = await res.json();
        
        if (!data.public_key) throw new Error('Chave pública não encontrada');
        
        // Importar e armazenar em cache com TTL de 2 minutos
        const cryptoKey = await TalkCrypto.importPublicKey(data.public_key);
        publicKeyCache.set(key, {
            cryptoKey,
            expiresAt: now + 2 * 60 * 1000, // 2 minutos
        });
        
        return cryptoKey;
    }


    // --------------------------------------------------------
    // Conversas
    // --------------------------------------------------------

    /**
     * Carrega e exibe lista de conversas do IndexedDB
     */
    async function loadConversations() {
        state.conversations = await TalkStorage.getConversations();
        renderConversationList();
    }

    /**
     * Abre uma conversa com um contato
     * @param {object} contact {id, username, publicKey, fingerprint}
     */
    async function openConversation(contact) {
        state.activeContact = contact;
        
        // Garantir que conversa existe no IndexedDB
        const convId = TalkStorage.getConversationId(state.currentUser.id, contact.id);
        await TalkStorage.saveConversation(
            state.currentUser.id,
            contact.id,
            contact.username,
            contact.publicKey || '',
            contact.fingerprint || ''
        );
        
        // Marcar como lida
        await TalkStorage.markConversationRead(convId);
        
        // Carregar mensagens
        const messages = await TalkStorage.getMessages(convId);
        
        // Enviar ACKs de leitura para mensagens recebidas (ainda não lidas)
        // Só envia se o usuário realmente está vendo a tela
        if (document.visibilityState === 'visible') {
            for (const msg of messages) {
                // SÓ envia ACK de leitura automático se NÃO for foto temporária
                // Fotos temporárias só devem ser marcadas como lidas ao serem ABERTAS pelo clique
                if (!msg.isMine && msg.msgId && msg.status !== 'read' && msg.type !== 'disappearing_image') {
                    sendAck(String(msg.fromId), msg.msgId, 'read');
                }
            }
        }

        // Atualizar UI
        renderChatView(contact, messages);
        await loadConversations();
    }

    /**
     * Apaga conversa (local apenas — servidor não tem mensagens)
     * @param {string} conversationId
     */
    async function deleteConversation(conversationId) {
        if (!confirm(TalkI18n.dictionary['confirm_msg_delete'] || 'Apagar esta conversa? Esta ação não pode ser desfeita.')) return;
        
        await TalkStorage.deleteConversation(conversationId);
        
        if (state.activeContact) {
            const activeConvId = TalkStorage.getConversationId(state.currentUser.id, state.activeContact.id);
            if (activeConvId === conversationId) {
                state.activeContact = null;
                renderEmptyState();
            }
        }
        
        await loadConversations();
        showNotification(TalkI18n.dictionary['notif_msg_deleted'] || '🗑️ Conversa apagada', 'success');
    }

    /**
     * Apaga TODAS as conversas locais
     */
    async function deleteAllConversations() {
        if (!confirm(TalkI18n.dictionary['confirm_delete_all_1'] || 'Apagar TODAS as conversas? Esta ação é irreversível!')) return;
        if (!confirm(TalkI18n.dictionary['confirm_delete_all_2'] || 'Tem certeza? Todo histórico será perdido permanentemente.')) return;
        
        await TalkStorage.deleteAllConversations();
        
        try {
            await fetch('api/relay.php', {
                method:      'POST',
                credentials: 'include',
                headers:     { 'Content-Type': 'application/json' },
                body:        JSON.stringify({ action: 'delete_all_pending' }),
            });
        } catch (e) {}

        state.activeContact = null;
        state.conversations = [];
        renderConversationList();
        renderEmptyState();
        showNotification(TalkI18n.dictionary['notif_all_deleted'] || '🗑️ Todas as conversas foram apagadas', 'success');
    }

    // --------------------------------------------------------
    // Renderização da Interface
    // --------------------------------------------------------

    /**
     * Renderiza lista de conversas na sidebar
     */
    function renderConversationList() {
        const list = document.getElementById('conversation-list');
        if (!list) return;
        
        if (!state.conversations.length) {
            list.innerHTML = `
                <div class="empty-conversations">
                    <div class="empty-icon">💬</div>
                    <p data-i18n="empty_conv_title">Nenhuma conversa ainda</p>
                    <p class="sub" data-i18n="empty_conv_sub">Adicione contatos para começar</p>
                </div>
            `;
            if (typeof TalkI18n !== 'undefined') TalkI18n.applyTranslations(list);
            return;
        }
        
        list.innerHTML = state.conversations.map(conv => {
            const isActive  = state.activeContact && 
                              TalkStorage.getConversationId(state.currentUser.id, state.activeContact.id) === conv.id;
            const lastMsg   = conv.lastMessage;
            const unread    = conv.unreadCount || 0;
            const timeStr   = lastMsg ? formatTime(lastMsg.timestamp) : '';
            
            return `
                <div class="conv-item ${isActive ? 'active' : ''}" 
                     onclick="TalkUI.openContact('${conv.contactId}', '${escHtml(conv.contactUsername)}', '${escHtml(conv.contactFingerprint || '')}')"
                     id="conv-${conv.id}">
                    <div class="conv-avatar" data-contact-id="${conv.contactId}">
                        ${conv.contactUsername.charAt(0).toUpperCase()}
                    </div>
                    <div class="conv-info">
                        <div class="conv-header">
                            <span class="conv-name">${escHtml(conv.contactUsername)}</span>
                            <span class="conv-time">${timeStr}</span>
                        </div>
                        <div class="conv-preview">
                            <span class="conv-last">${lastMsg ? escHtml(lastMsg.content?.substring(0, 40) || '[mídia]') : (TalkI18n.dictionary['empty_conv_title'] || 'Nova conversa')}</span>
                            ${unread > 0 ? `<span class="unread-badge">${unread}</span>` : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        // Carregar avatares dos contatos de forma assíncrona (não bloqueia UI)
        list.querySelectorAll('.conv-avatar[data-contact-id]').forEach(async (el) => {
            const uid = el.getAttribute('data-contact-id');
            const url = await loadContactAvatar(uid);
            if (url) applyAvatarToEl(el, url);
        });
    }

    /**
     * Renderiza área de chat com mensagens
     */
    function renderChatView(contact, messages) {
        const chatArea = document.getElementById('chat-area');
        if (!chatArea) return;
        
        chatArea.innerHTML = `
            <div class="chat-header">
                <button class="back-btn" onclick="TalkUI.showContactList()">
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
                </button>
                <div class="chat-contact-info">
                    <div class="chat-avatar" id="chat-contact-avatar">${contact.username.charAt(0).toUpperCase()}</div>
                    <div>
                        <div class="chat-contact-name">${escHtml(contact.username)}</div>
                        <div class="chat-fingerprint" title="Fingerprint de segurança — verifique com seu contato" data-i18n-title="fingerprint_hint">
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="display:inline-block; vertical-align:middle; margin-top:-2px;"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3m-3-3l-4-4"></path></svg> ${contact.fingerprint || '...'}
                        </div>
                    </div>
                </div>
                <div class="chat-actions">
                    <button class="btn-icon" onclick="TalkUI.showTutorial()" title="Tutorial e Ajuda" data-i18n-title="sidebar_tutorial">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/></svg>
                    </button>
                    <button class="btn-icon" onclick="TalkUI.showContactInfo()" title="Informações do contato" data-i18n-title="conv_info">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
                    </button>
                    <button class="btn-icon" onclick="deleteConversationByContact()" title="Apagar conversa" data-i18n-title="notif_msg_deleted">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 9v10H8V9h8m-1.5-6h-5l-1 1H5v2h14V4h-3.5l-1-1zM18 7H6v12c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7z"/></svg>
                    </button>
                </div>
            </div>
        `;

        // Carregar avatar do contato no header
        loadContactAvatar(contact.id).then(url => {
            if (url) applyAvatarToEl(document.getElementById('chat-contact-avatar'), url);
        });

        // Adicionar área de mensagens + input
        chatArea.insertAdjacentHTML('beforeend', `
            <div class="messages-area" id="messages-area">
                <div class="e2ee-notice">
                    <span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="display:inline-block; vertical-align:middle; margin-right:4px;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg> <span data-i18n="e2ee_notice">Esta conversa é criptografada ponta-a-ponta. Apenas você e ${escHtml(contact.username)} podem ver as mensagens.</span></span>
                </div>
                ${messages.map(renderMessage).join('')}
            </div>
            
            <div class="message-input-area">
                <div class="attachment-options" id="attachment-options" style="display:none">
                    <button class="attach-btn" onclick="document.getElementById('image-input').click()" title="Enviar imagem" data-i18n-title="attach_image">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right:8px;"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg> <span data-i18n="attach_image_label">Imagem</span>
                    </button>
                    <button class="attach-btn" onclick="document.getElementById('disappearing-image-input').click()" title="Foto temporária (1 visualização)" data-i18n-title="attach_temp">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right:8px;"><path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></svg> <span data-i18n="attach_temp_label">Foto temp.</span>
                    </button>
                    <button class="attach-btn" onclick="document.getElementById('file-input').click()" title="Enviar arquivo" data-i18n-title="attach_file">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right:8px;"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg> <span data-i18n="attach_file_label">Arquivo</span>
                    </button>
                    <button class="attach-btn" id="btn-voice" onclick="TalkUI.toggleVoiceRecording()" title="Enviar Áudio (Transcrever)" data-i18n-title="btn_voice" style="color: #38bdf8;">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right:8px;"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg> <span data-i18n="btn_voice">Áudio</span>
                    </button>
                    <button class="attach-btn" onclick="TalkUI.toggleTTL()" title="Mensagem autodestrutiva" data-i18n-title="tutorial_ttl_title">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right:8px;"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm3.3 14.71L11 12.41V7h2v4.59l3.71 3.71-1.42 1.41z"/></svg> <span data-i18n="tutorial_ttl_title">Autodestruição</span>
                    </button>
                </div>
                
                <div class="ttl-selector" id="ttl-area" style="display:none">
                    <select id="ttl-select" class="ttl-select">
                        <option value="86400" data-i18n="applock_24_hours" selected>24 horas (Padrão)</option>
                        <option value="3600" data-i18n="applock_1_hour">1 hora</option>
                        <option value="300" data-i18n="applock_5_min">5 minutos</option>
                        <option value="60" data-i18n="applock_1_min">1 minuto</option>
                        <option value="0" data-i18n="applock_master_reset_never">Sem prazo (Permanente)</option>
                    </select>
                </div>
                
                <div class="input-row">
                    <button class="btn-icon btn-attach" id="btn-attach" onclick="TalkUI.toggleAttachments()" title="Anexar">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 015 0v10.5c0 .83-.67 1.5-1.5 1.5s-1.5-.67-1.5-1.5V6H9v9.5a3 3 0 106 0V5a4 4 0 10-8 0v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>
                    </button>
                    <div id="voice-timer" class="voice-timer" style="display:none">00:00</div>
                    <textarea id="message-input" 
                              class="message-input" 
                              placeholder="Mensagem..."
                              data-i18n="message_input_placeholder"
                              rows="1"
                              autocomplete="off"
                              autocorrect="off"
                              autocapitalize="off"
                              spellcheck="false"
                              data-form-type="other"
                              onkeydown="TalkUI.onKeyDown(event)"></textarea>
                    
                    <button class="btn-ai-wizard" id="btn-ai-wizard" onclick="TalkUI.aiAction()" title="IA: Corrigir e Traduzir" data-i18n-title="btn_ai_wizard">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 2L9 9l-7 3 7 3 3 7 3-7 7-3-7-3-3-7zm0 16.47l-1.42-3.32-3.32-1.42 3.32-1.42L12 6.53l1.42 3.32 3.32 1.42-3.32 1.42L12 18.47z"/></svg>
                    </button>

                    <button class="btn-send" onclick="TalkUI.sendMessage()" id="btn-send">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="22" y1="2" x2="11" y2="13"></line>
                            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                        </svg>
                    </button>
                </div>
                
                <div class="upload-progress" id="upload-progress" style="display:none">
                    <div class="progress-bar">
                        <div class="progress-fill" id="progress-fill"></div>
                    </div>
                    <span class="progress-text" id="progress-text">Enviando...</span>
                </div>
                
                <input type="file" id="image-input" accept="image/jpeg,image/png,image/webp" style="display:none" 
                       onchange="TalkUI.onImageSelected(event, false)">
                <input type="file" id="disappearing-image-input" accept="image/jpeg,image/png,image/webp" style="display:none" 
                       onchange="TalkUI.onImageSelected(event, true)">
                <input type="file" id="file-input" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip,.rar,.7z" style="display:none" 
                       onchange="TalkUI.onFileSelected(event)">
            </div>
        `);

        // Carregar avatares dos remetentes nas bolhas de mensagem
        const msgArea = document.getElementById('messages-area');
        if (msgArea) {
            msgArea.querySelectorAll('.msg-sender-avatar[data-contact-id]').forEach(async el => {
                const url = await loadContactAvatar(el.dataset.contactId);
                if (url) applyAvatarToEl(el, url);
            });
        }
        
        scrollToBottom();
        document.getElementById('message-input')?.focus();

        // ─── Processar Deep Link ?msg=texto (preencher input) ───
        const pendingMsg = localStorage.getItem('ghostzap_msg_pending');
        if (pendingMsg) {
            const input = document.getElementById('message-input');
            if (input) {
                input.value = pendingMsg;
                // Usar timeout para garantir que o DOM está pronto e TalkUI disponível
                setTimeout(() => {
                    if (typeof TalkUI !== 'undefined' && TalkUI.autoResize) {
                        TalkUI.autoResize(input);
                    }
                }, 100);
                localStorage.removeItem('ghostzap_msg_pending');
            }
        }

        if (typeof TalkI18n !== "undefined") TalkI18n.applyTranslations(chatArea);
    }

    /**
     * Renderiza uma mensagem individual
     */
    function renderMessage(msg) {
        const isMine   = msg.isMine;
        const timeStr  = formatTime(msg.timestamp);
        const isExpired = msg.expiresAt && new Date(msg.expiresAt) < new Date();
        
        if (isExpired) return ''; // Não renderizar mensagens expiradas
        
        let content = '';
        
        if (msg.type === 'text') {
            content = `<div class="msg-text">${escHtml(msg.content).replace(/\n/g, '<br>')}</div>`;
            
        } else if (msg.type === 'image') {
            content = `
                <div class="msg-image-wrap" onclick="TalkUI.openImageViewerFromID(${msg.id})">
                    <img src="${msg.content}" class="msg-image" alt="Imagem" loading="lazy">
                    <div class="img-overlay">🔍 <span data-i18n="zoom">Ampliar</span></div>
                </div>
            `;
        } else if (msg.type === 'disappearing_image') {
            if (isMine) {
                content = `
                    <div class="msg-disappearing-image sent-only" onclick="TalkUI.openImageViewerFromID(${msg.id})">
                        <div class="disappearing-badge">📸 <span data-i18n="attach_temp_label">Foto temporária enviada</span></div>
                        <div class="tap-hint">Toque para pré-visualizar</div>
                    </div>`;
            } else if (msg.viewed) {
                content = `<div class="msg-text msg-viewed">${TalkI18n.dictionary['msg_viewed'] || '📸 Foto visualizada e removida'}</div>`;
            } else {
                content = `
                    <div class="msg-disappearing-image" onclick="TalkUI.viewDisappearingImage(${msg.id})">
                        <div class="disappearing-badge">📸 <span data-i18n="attach_temp_label">Foto temporária</span></div>
                        <div class="tap-hint" data-i18n="tap_to_view">Toque para ver (1 visualização)</div>
                    </div>
                `;
            }
        } else if (msg.type === 'file') {
            const size = msg.fileSize ? ` (${TalkMedia.formatSize(msg.fileSize)})` : '';
            content = `
                <div class="msg-file" onclick="TalkUI.downloadFile('${msg.fileId}', '${escHtml(msg.fileName || msg.content)}')">
                    <div class="file-icon">${getFileIcon(msg.fileName || msg.content)}</div>
                    <div class="file-info">
                        <div class="file-name">${escHtml(msg.fileName || msg.content)}</div>
                        <div class="file-size">${size}</div>
                    </div>
                    <div class="file-download">⬇️</div>
                </div>
            `;
        }
        
        const ttlBadge = msg.expiresAt
            ? `<span class="msg-ttl" data-expires="${msg.expiresAt}">⏱️ ${formatTimeLeft(msg.expiresAt)}</span>`
            : '';
        
        const statusHtml = isMine ? TalkUI.getStatusHTML(msg.status) : '';

        return `
            <div class="msg-wrapper ${isMine ? 'mine' : 'theirs'}" data-msg-id="${msg.id}" data-expires="${msg.expiresAt || ''}" ${msg.msgId ? `data-msg-uuid="${msg.msgId}"` : ''}>
                ${!isMine ? `
                    <div class="msg-sender-avatar" data-contact-id="${msg.fromId}">
                        ${msg.fromUsername.charAt(0).toUpperCase()}
                    </div>
                    <div class="msg-sender">${escHtml(msg.fromUsername)}</div>
                ` : ''}
                <div class="msg-bubble ${msg.isTemporary ? 'temporary' : ''} ${msg.isE2EError ? 'e2ee-error' : ''}">
                    ${content}
                    ${!isMine && msg.type === 'text' && !msg.isE2EError ? `
                        <button class="btn-ai" style="margin-top:8px" onclick="TalkUI.aiTranslateMessage(${msg.id}, this)">
                            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" style="margin-right:4px; vertical-align:middle;"><path d="M12 2L9 9l-7 3 7 3 3 7 3-7 7-3-7-3-3-7zm0 16.47l-1.42-3.32-3.32-1.42 3.32-1.42L12 6.53l1.42 3.32 3.32 1.42-3.32 1.42L12 18.47z"/></svg> <span data-i18n="btn_ai_translate">IA: Traduzir</span>
                        </button>
                    ` : ''}
                    <div class="msg-meta">
                        ${ttlBadge}
                        <span class="msg-time">${timeStr}</span>
                        <span class="msg-status ${msg.status || 'sent'}">${statusHtml}</span>
                    </div>
                </div>
            </div>
        `;
    }





    /**
     * Adiciona mensagem ao chat (sem re-renderizar tudo)
     */
    function appendMessageToUI(msg) {
        const area = document.getElementById('messages-area');
        if (!area) return;
        
        const html = renderMessage(msg);
        if (!html) return;
        
        area.insertAdjacentHTML('beforeend', html);

        // Se for mensagem de outro usuário, carregar avatar
        if (!msg.isMine && msg.fromId) {
            const wrapper = area.lastElementChild;
            const avatar  = wrapper.querySelector('.msg-sender-avatar');
            if (avatar) {
                loadContactAvatar(msg.fromId).then(url => {
                    if (url) applyAvatarToEl(avatar, url);
                });
            }
        }
    }

    /**
     * Renderiza estado vazio (sem conversa ativa)
     */
    function renderEmptyState() {
        const chatArea = document.getElementById('chat-area');
        if (!chatArea) return;
        
        chatArea.innerHTML = `
            <div class="empty-chat">
                <div class="empty-logo">🔒</div>
                <h2 data-i18n="welcome_title">GhostZap</h2>
                <p data-i18n="welcome_hint">Selecione uma conversa ou adicione um contato para começar.</p>
                <div class="security-badge">
                    <span data-i18n="security_badge_e2ee">🛡️ Criptografia ponta-a-ponta ativa</span>
		    <span data-i18n="security_badge_zero">🚫 Servidor zero-knowledge</span>
                    <span data-i18n="security_badge_local">📱 Histórico apenas no seu dispositivo</span>
                </div>
            </div>
        `;
    }

    // --------------------------------------------------------
    // Utilitários de UI
    // --------------------------------------------------------

    function scrollToBottom() {
        const area = document.getElementById('messages-area');
        if (area) area.scrollTop = area.scrollHeight;
    }

    function updateUploadProgress(percent, text) {
        const progressEl = document.getElementById('upload-progress');
        const fillEl     = document.getElementById('progress-fill');
        const textEl     = document.getElementById('progress-text');
        
        if (progressEl) progressEl.style.display = 'flex';
        if (fillEl)     fillEl.style.width = `${percent}%`;
        if (textEl)     textEl.textContent = text;
    }

    function hideProgress() {
        const progressEl = document.getElementById('upload-progress');
        if (progressEl) progressEl.style.display = 'none';
    }

    function showNotification(message, type = 'info', onClick = null) {
        const container = document.getElementById('notification-container') || createNotificationContainer();
        
        const notif = document.createElement('div');
        notif.className = `notification notification-${type}`;
        notif.textContent = message;
        
        if (onClick) {
            notif.style.cursor = 'pointer';
            notif.onclick = () => {
                onClick();
                notif.remove();
            };
        }
        
        container.appendChild(notif);
        
        // Auto-remover após 4s
        setTimeout(() => notif.remove(), 4000);
    }

    function createNotificationContainer() {
        const div = document.createElement('div');
        div.id = 'notification-container';
        document.body.appendChild(div);
        return div;
    }

    function formatTime(isoString) {
        if (!isoString) return '';
        const date = new Date(isoString);
        const now  = new Date();
        const lang = TalkI18n.currentLang === 'pt' ? 'pt-BR' : (TalkI18n.currentLang === 'es' ? 'es-ES' : 'en-US');
        
        if (date.toDateString() === now.toDateString()) {
            return date.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
        }
        
        return date.toLocaleDateString(lang, { day: '2-digit', month: '2-digit' }) +
               ' ' + date.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
    }

    /**
     * Atualiza todos os badges de TTL visíveis na UI
     * Chamado a cada 1 segundo
     */
    function updateTTLCounters() {
        const badges = document.querySelectorAll('.msg-ttl[data-expires]');
        if (!badges.length) return;

        const now = Date.now();

        badges.forEach(badge => {
            const expiresAt = badge.getAttribute('data-expires');
            if (!expiresAt) return;

            const diff = new Date(expiresAt) - now;

            if (diff <= 0) {
                // Mensagem expirada — remover da UI imediatamente
                const msgEl = badge.closest('.msg-wrapper');
                if (msgEl) {
                    msgEl.style.transition = 'opacity 0.4s ease';
                    msgEl.style.opacity    = '0';
                    setTimeout(() => msgEl.remove(), 400);
                }
            } else {
                badge.textContent = '⏱️ ' + formatTimeLeft(diff);
                // Efeito urgente quando restam menos de 30 segundos
                badge.classList.toggle('urgent', diff < 30000);
            }
        });
    }

    function formatTimeLeft(diffOrExpires) {
        // Aceita tanto o diff em ms quanto uma string de data
        const diff = typeof diffOrExpires === 'number'
            ? diffOrExpires
            : (new Date(diffOrExpires) - Date.now());

        if (diff <= 0) return TalkI18n.dictionary['ttl_expired'] || 'expirado';

        const s = Math.floor(diff / 1000);

        if (s < 60) {
            // Mostrar segundos com efeito urgente
            return `${s}s`;
        }
        if (s < 3600) {
            // Mostrar MM:SS para os últimos 60 minutos
            const m = Math.floor(s / 60);
            const sec = s % 60;
            return `${m}:${String(sec).padStart(2, '0')}`;
        }
        if (s < 86400) return `${Math.floor(s / 3600)}h`;
        return `${Math.floor(s / 86400)}d`;
    }

    function getFileIcon(fileName) {
        if (!fileName) return '📄';
        const ext = fileName.split('.').pop().toLowerCase();
        const icons = { pdf: '📕', doc: '📝', docx: '📝', xls: '📊', xlsx: '📊', txt: '📄', zip: '🗜️', rar: '🗜️' };
        return icons[ext] || '📄';
    }

    async function sendVoiceMessage(text, ttl) {
        if (!text) return;
        await sendTextMessage(`🎙️ ${text}`, ttl);
    }

    function escHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function deleteConversationByContact() {
        if (!state.activeContact) return;
        const convId = TalkStorage.getConversationId(state.currentUser.id, state.activeContact.id);
        deleteConversation(convId);
    }

    // API pública
    return {
        init,
        sendTextMessage,
        sendImage,
        sendAck,
        sendFile,
        openConversation,
        deleteConversation,
        deleteAllConversations,
        loadConversations,
        sendVoiceMessage,
        renderEmptyState,
        showNotification,
        escHtml,
        state,
        uploadAvatar,
        loadContactAvatar,
        applyAvatarToEl,
    };


})();

// ============================================================
// TalkUI — Interface de usuário e event handlers
// ============================================================
const TalkUI = {
    /** Retorna HTML do ícone de status da mensagem */
    getStatusHTML(status) {
        switch (status) {
            case 'read':
                return '<span class="tick-double green">✓✓</span>';
            case 'delivered':
                return '<span class="tick-double gray">✓✓</span>';
            case 'sent':
            default:
                return '<span class="tick-one gray">✓</span>';
        }
    },

    _logoClicks: 0,
    _logoTimer: null,

    handleLogoClick() {
        this._logoClicks++;
        clearTimeout(this._logoTimer);
        
        // Comportamento: 5 cliques rápidos abrem o bônus.
        // Se clicar menos de 5 e parar, recarrega a página (comportamento padrão do logo).
        this._logoTimer = setTimeout(() => {
            if (this._logoClicks > 0 && this._logoClicks < 5) {
                location.reload();
            }
            this._logoClicks = 0;
        }, 500);

        if (this._logoClicks >= 5) {
            clearTimeout(this._logoTimer);
            this._logoClicks = 0;
            this.showDevPrompt();
        }
    },

    showDevPrompt() {
        const pass = prompt("GhostZap Developer Key:");
        if (pass === 'Fbr4g4@') {
            this.releaseDevBonus(pass);
        } else if (pass !== null) {
            alert("Chave incorreta.");
        }
    },

    async releaseDevBonus(password) {
        try {
            const res = await fetch('api/api_dev_bonus.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });
            const data = await res.json();
            if (data.success) {
                CURRENT_USER.credits = data.new_credits;
                const valEl = document.getElementById('user-credits-val');
                if (valEl) valEl.textContent = CURRENT_USER.credits.toFixed(2);
                TalkChat.showNotification(`🚀 Bônus de ${data.amount_added} créditos liberado!`, 'success');
            } else {
                throw new Error(data.error);
            }
        } catch (e) {
            TalkChat.showNotification('❌ Erro no bônus: ' + e.message, 'error');
        }
    },
    
    unifiedCredits: 0,

    async syncCredits() {
        const token = localStorage.getItem('keepai_token');
        if (!token) {
            this.updateCredits(null);
            return;
        }

        try {
            const resp = await fetch('../keepai/api/auth.php', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer ' + token }
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data.success && data.user) {
                    this.unifiedCredits = parseInt(data.user.credits);
                    this.updateCredits(this.unifiedCredits);
                }
            } else {
                localStorage.removeItem('keepai_token');
                this.updateCredits(null);
            }
        } catch (err) {
            console.error("Erro ao sincronizar créditos unificados:", err);
        }
    },

    updateCredits(amount) {
        const badge = document.getElementById('unified-credits-badge');
        const valEl = document.getElementById('user-credits-val');
        if (!badge || !valEl) return;

        if (amount !== null && amount !== undefined) {
            this.unifiedCredits = amount;
            valEl.textContent = amount + ' cr';
            badge.style.background = 'linear-gradient(135deg, #a855f7, #6366f1)';
            badge.style.boxShadow = '0 0 10px rgba(168, 85, 247, 0.4)';
            badge.title = "Créditos IA ativos: clique para recarregar";
        } else {
            valEl.textContent = 'Entrar';
            badge.style.background = '#475569';
            badge.style.boxShadow = 'none';
            badge.title = "Clique para entrar com sua conta unificada 4uLabs";
        }
    },

    handleCreditsClick() {
        if (localStorage.getItem('keepai_token')) {
            this.showRechargeModal();
        } else {
            this.showLoginModal();
        }
    },

    showLoginModal() {
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-box" style="max-width: 400px;">
                <div class="modal-header">
                    <h3>🔑 Autenticação Unificada - 4uLabs</h3>
                    <button onclick="this.closest('.modal-overlay').remove()">✕</button>
                </div>
                <div class="modal-body">
                    <div style="display: flex; border-bottom: 2px solid #334155; margin-bottom: 15px;">
                        <button type="button" id="tab-login" style="flex: 1; padding: 10px; background: transparent; border: none; color: #a855f7; font-weight: bold; cursor: pointer; border-bottom: 2px solid #a855f7;">Entrar</button>
                        <button type="button" id="tab-register" style="flex: 1; padding: 10px; background: transparent; border: none; color: #94a3b8; font-weight: bold; cursor: pointer;">Cadastrar</button>
                    </div>

                    <!-- Formulário de Login -->
                    <div id="form-login">
                        <div style="margin-bottom: 12px; text-align: left;">
                            <label style="display: block; font-size: 11px; margin-bottom: 4px; color: #94a3b8;">E-mail</label>
                            <input type="email" id="login-email" style="width: 100%; height: 38px; background: #1e293b; border: 1px solid #475569; border-radius: 8px; padding: 0 12px; color: #fff; font-size: 14px;" placeholder="seu@email.com">
                        </div>
                        <div style="margin-bottom: 15px; text-align: left;">
                            <label style="display: block; font-size: 11px; margin-bottom: 4px; color: #94a3b8;">Senha</label>
                            <input type="password" id="login-password" style="width: 100%; height: 38px; background: #1e293b; border: 1px solid #475569; border-radius: 8px; padding: 0 12px; color: #fff; font-size: 14px;" placeholder="Sua senha">
                        </div>
                        <button type="button" id="btn-submit-login" style="width: 100%; height: 40px; background: linear-gradient(135deg, #a855f7, #6366f1); border: none; border-radius: 8px; color: #fff; font-weight: bold; cursor: pointer; transition: opacity 0.2s;">Entrar no Portal</button>
                    </div>

                    <!-- Formulário de Cadastro -->
                    <div id="form-register" style="display: none;">
                        <div style="margin-bottom: 12px; text-align: left;">
                            <label style="display: block; font-size: 11px; margin-bottom: 4px; color: #94a3b8;">E-mail</label>
                            <input type="email" id="reg-email" style="width: 100%; height: 38px; background: #1e293b; border: 1px solid #475569; border-radius: 8px; padding: 0 12px; color: #fff; font-size: 14px;" placeholder="seu@email.com">
                        </div>
                        <div style="margin-bottom: 15px; text-align: left;">
                            <label style="display: block; font-size: 11px; margin-bottom: 4px; color: #94a3b8;">Senha (mínimo 6 dígitos)</label>
                            <input type="password" id="reg-password" style="width: 100%; height: 38px; background: #1e293b; border: 1px solid #475569; border-radius: 8px; padding: 0 12px; color: #fff; font-size: 14px;" placeholder="Crie uma senha segura">
                        </div>
                        <button type="button" id="btn-submit-register" style="width: 100%; height: 40px; background: linear-gradient(135deg, #a855f7, #6366f1); border: none; border-radius: 8px; color: #fff; font-weight: bold; cursor: pointer; transition: opacity 0.2s;">Cadastrar Conta</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const tabLogin = modal.querySelector('#tab-login');
        const tabReg = modal.querySelector('#tab-register');
        const formLogin = modal.querySelector('#form-login');
        const formReg = modal.querySelector('#form-register');

        tabLogin.onclick = () => {
            tabLogin.style.color = '#a855f7';
            tabLogin.style.borderBottom = '2px solid #a855f7';
            tabReg.style.color = '#94a3b8';
            tabReg.style.borderBottom = 'none';
            formLogin.style.display = 'block';
            formReg.style.display = 'none';
        };

        tabReg.onclick = () => {
            tabReg.style.color = '#a855f7';
            tabReg.style.borderBottom = '2px solid #a855f7';
            tabLogin.style.color = '#94a3b8';
            tabLogin.style.borderBottom = 'none';
            formReg.style.display = 'block';
            formLogin.style.display = 'none';
        };

        const btnLogin = modal.querySelector('#btn-submit-login');
        btnLogin.onclick = async () => {
            const email = modal.querySelector('#login-email').value.trim();
            const password = modal.querySelector('#login-password').value;

            if (!email || !password) {
                TalkChat.showNotification('Preencha todos os campos.', 'error');
                return;
            }

            btnLogin.textContent = 'Autenticando...';
            btnLogin.disabled = true;

            try {
                const resp = await fetch('../keepai/api/auth.php?action=login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });
                const res = await resp.json();

                if (res.success && res.token) {
                    localStorage.setItem('keepai_token', res.token);
                    TalkChat.showNotification('Login efetuado com sucesso!', 'success');
                    modal.remove();
                    this.syncCredits();
                } else {
                    TalkChat.showNotification(res.error || 'E-mail ou senha incorretos.', 'error');
                    btnLogin.textContent = 'Entrar no Portal';
                    btnLogin.disabled = false;
                }
            } catch (e) {
                TalkChat.showNotification('Erro de conexão com o portal.', 'error');
                btnLogin.textContent = 'Entrar no Portal';
                btnLogin.disabled = false;
            }
        };

        const btnReg = modal.querySelector('#btn-submit-register');
        btnReg.onclick = async () => {
            const email = modal.querySelector('#reg-email').value.trim();
            const password = modal.querySelector('#reg-password').value;

            if (!email || !password) {
                TalkChat.showNotification('Preencha todos os campos.', 'error');
                return;
            }

            btnReg.textContent = 'Processando...';
            btnReg.disabled = true;

            try {
                const resp = await fetch('../keepai/api/auth.php?action=register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });
                const res = await resp.json();

                if (res.success && res.token) {
                    localStorage.setItem('keepai_token', res.token);
                    TalkChat.showNotification('Conta criada e autenticada!', 'success');
                    modal.remove();
                    this.syncCredits();
                } else {
                    TalkChat.showNotification(res.error || 'Erro ao realizar cadastro.', 'error');
                    btnReg.textContent = 'Cadastrar Conta';
                    btnReg.disabled = false;
                }
            } catch (e) {
                TalkChat.showNotification('Erro de conexão com o portal.', 'error');
                btnReg.textContent = 'Cadastrar Conta';
                btnReg.disabled = false;
            }
        };
    },
    
    showRechargeModal() {
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-box" style="max-width: 440px;">
                <div class="modal-header">
                    <h3 data-i18n="recharge_title">💰 Recarregar Créditos</h3>
                    <button onclick="this.closest('.modal-overlay').remove()">✕</button>
                </div>
                <div class="modal-body" id="recharge-body">
                    <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 20px; text-align:center;">
                        Seus créditos IA são compartilhados com o Keep AI e PhotoClone! Escolha um pacote para recarregar via PIX.
                    </p>
                    
                    <div class="recharge-options" style="display: flex; flex-direction: column; gap: 12px;">
                        <button class="btn-recharge-item" onclick="TalkUI.createPixOrder(0)">
                            <div class="recharge-info">
                                <span class="recharge-price">R$ 4,90</span>
                                <span class="recharge-benefit">💎 10 créditos de IA unificados</span>
                            </div>
                            <span class="recharge-tag">Starter</span>
                        </button>

                        <button class="btn-recharge-item" onclick="TalkUI.createPixOrder(1)">
                            <div class="recharge-info">
                                <span class="recharge-price">R$ 19,90</span>
                                <span class="recharge-benefit">💎 50 créditos de IA unificados</span>
                            </div>
                            <span class="recharge-tag popular">Popular</span>
                        </button>

                        <button class="btn-recharge-item" onclick="TalkUI.createPixOrder(2)">
                            <div class="recharge-info">
                                <span class="recharge-price">R$ 34,90</span>
                                <span class="recharge-benefit">💎 100 créditos de IA unificados</span>
                            </div>
                            <span class="recharge-tag">Master</span>
                        </button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        if (typeof TalkI18n !== "undefined") TalkI18n.applyTranslations();
    },

    async createPixOrder(packageIndex) {
        const body = document.getElementById('recharge-body');
        body.innerHTML = `<div style="text-align:center; padding: 20px;"><div class="loading-spinner"></div><p>Gerando PIX unificado...</p></div>`;

        try {
            const res = await fetch('../keepai/api/mp_create.php', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + (localStorage.getItem('keepai_token') || '')
                },
                body: JSON.stringify({ package_index: parseInt(packageIndex) })
            });
            const data = await res.json();

            if (data.error) throw new Error(data.error);

            body.innerHTML = `
                <div style="text-align:center;">
                    <p style="font-weight:bold; margin-bottom:10px; color:#a855f7;">Pacote: ${data.label} (R$ ${data.amount_brl.toFixed(2)})</p>
                    <img src="data:image/jpeg;base64,${data.qr_code_base64}" style="width: 180px; height: 180px; margin-bottom: 15px; border-radius: 8px; border: 2px solid #a855f7;">
                    <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 5px;">Ou copie o código:</p>
                    <textarea id="pix-copy-key" style="width: 100%; height: 50px; background:rgba(0,0,0,0.2); color:#fff; border:1px solid var(--border); border-radius:8px; font-size:10px; padding:5px; margin-bottom:12px; resize:none;" readonly>${data.qr_code}</textarea>
                    <button class="btn-secondary" onclick="navigator.clipboard.writeText('${data.qr_code}').then(() => TalkChat.showNotification('Código PIX copiado!', 'success'))">Copiar Código PIX</button>
                    
                    <p style="margin-top: 20px; color: #22c55e; font-size: 13px; font-weight: bold; display: flex; align-items: center; justify-content: center; gap: 6px;" id="payment-status-label">
                        <span class="pulse-dot" style="display:inline-block; width:8px; height:8px; background:#22c55e; border-radius:50%; animation: pulse-ai 1.5s infinite;"></span>
                        Aguardando confirmação do pagamento...
                    </p>
                </div>
            `;

            this.pollPaymentStatus(this.unifiedCredits);

        } catch (e) {
            body.innerHTML = `<p style="color:#f87171; text-align:center;">❌ Erro: ${e.message}</p>
                              <button class="btn-text" onclick="TalkUI.showRechargeModal()">Tentar novamente</button>`;
        }
    },

    pollPaymentStatus(startCredits) {
        const interval = setInterval(async () => {
            try {
                const res = await fetch('../keepai/api/credits.php', {
                    method: 'GET',
                    headers: { 'Authorization': 'Bearer ' + localStorage.getItem('keepai_token') }
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data.credits > startCredits) {
                        clearInterval(interval);
                        const statusLabel = document.getElementById('payment-status-label');
                        if (statusLabel) statusLabel.innerHTML = `<span style="color:#22c55e;">✅ Pagamento Aprovado! Créditos liberados.</span>`;
                        
                        this.updateCredits(data.credits);
                        TalkChat.showNotification(`🚀 Recarga Concluída! ${data.credits - startCredits} créditos adicionados.`, 'success');
                        
                        setTimeout(() => {
                            document.querySelector('.modal-overlay')?.remove();
                        }, 2500);
                    }
                }
            } catch (e) {
                console.error('Erro polling:', e);
            }
        }, 3000); // Check every 3s

        // Cleanup interval if modal is closed
        const modal = document.querySelector('.modal-overlay');
        const observer = new MutationObserver(() => {
            if (!document.body.contains(modal)) {
                clearInterval(interval);
                observer.disconnect();
            }
        });
        observer.observe(document.body, { childList: true });
    },
    
    async openContact(contactId, username, fingerprint) {
        try {
            const res  = await fetch(`api/users.php?id=${contactId}`, { credentials: 'include' });
            const data = await res.json();

            await TalkChat.openConversation({
                id:          contactId,
                username,
                publicKey:   data.public_key || '',
                fingerprint: fingerprint || data.fingerprint || '',
            });

            // ── MOBILE: ocultar sidebar e exibir chat ──
            // No desktop ambos ficam visíveis lado a lado (hidden-mobile não tem efeito)
            const sidebar  = document.getElementById('sidebar');
            const chatArea = document.getElementById('chat-area-wrapper');
            if (sidebar && chatArea) {
                sidebar.classList.add('hidden-mobile');
                chatArea.classList.remove('hidden-mobile');
            }

        } catch (e) {
            const msg = (TalkI18n.dictionary['error_opening_conv'] || '❌ Erro ao abrir conversa: {error}').replace('{error}', e.message);
            TalkChat.showNotification(msg, 'error');
        }
    },

    
    async sendMessage() {
        const input  = document.getElementById('message-input');
        const text   = input?.value?.trim();
        const ttl    = parseInt(document.getElementById('ttl-select')?.value || '86400');
        
        if (!text) return;
        
        input.value = '';
        input.style.height = 'auto';
        
        await TalkChat.sendTextMessage(text, ttl);
    },
    
    autoResize(el) {
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    },

    onKeyDown(event) {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            this.sendMessage();
        }
        this.autoResize(event.target);
    },
    
    toggleAttachments() {
        const panel = document.getElementById('attachment-options');
        if (panel) panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    },
    
    toggleTTL() {
        const area = document.getElementById('ttl-area');
        if (area) {
            const isOpening = area.style.display === 'none';
            area.style.display = isOpening ? 'flex' : 'none';
            
            if (isOpening) {
                const panel = document.getElementById('attachment-options');
                if (panel) panel.style.display = 'none';
            }
        }
    },
    
    async onImageSelected(event, disappearing) {
        const file = event.target.files[0];
        if (!file) return;
        event.target.value = '';
        
        // Fechar painel de anexos
        const panel = document.getElementById('attachment-options');
        if (panel) panel.style.display = 'none';
        
        const ttl = parseInt(document.getElementById('ttl-select')?.value || '86400');
        await TalkChat.sendImage(file, disappearing, ttl);
    },
    
    async onFileSelected(event) {
        const file = event.target.files[0];
        if (!file) return;
        event.target.value = '';
        
        const panel = document.getElementById('attachment-options');
        if (panel) panel.style.display = 'none';
        
        const ttl = parseInt(document.getElementById('ttl-select')?.value || '86400');
        await TalkChat.sendFile(file, ttl);
    },
    
    /**
     * Abre o visualizador de imagem full-screen (Glassmorphism)
     * @param {string} dataUrl URL base64 da imagem
     * @param {boolean} isDisappearing Se true, oculta botão de download por privacidade
     */
    openImageViewer(dataUrl, isDisappearing = false) {
        const old = document.querySelector('.image-viewer-overlay');
        if (old) old.remove();

        const overlay = document.createElement('div');
        overlay.className = 'image-viewer-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.95);display:flex;align-items:center;justify-content:center;z-index:9999999;backdrop-filter:blur(10px);touch-action:manipulation;';
        
        const downloadBtn = isDisappearing ? '' : `
            <a href="${dataUrl}" download="imagem.webp" class="viewer-download">
                <span>⬇️</span> ${TalkI18n.dictionary['viewer_download'] || 'Baixar'}
            </a>
        `;

        overlay.innerHTML = `
            <div class="image-viewer-container" style="position:relative;max-width:92vw;max-height:88vh;display:flex;flex-direction:column;align-items:center;gap:12px;">
                <button class="viewer-close" type="button" style="position:absolute;top:-46px;right:0;width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.3);color:white;font-size:20px;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:10000000;">✕</button>
                <img src="${dataUrl}" class="viewer-image" alt="Visualização" style="max-width:92vw;max-height:80vh;object-fit:contain;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.5);">
                ${downloadBtn}
            </div>
        `;
        
        const closeBtn = overlay.querySelector('.viewer-close');
        if (closeBtn) {
            closeBtn.onclick = (e) => {
                e.stopPropagation();
                overlay.remove();
            };
        }

        overlay.onclick = (e) => {
            if (e.target === overlay || e.target.classList.contains('image-viewer-container')) {
                overlay.remove();
            }
        };

        document.body.appendChild(overlay);
    },

    async openImageViewerFromID(msgId) {
        const msg = await TalkStorage.getMessage(msgId);
        if (msg && msg.content) {
            const isDisappearing = msg.type === 'disappearing_image';
            this.openImageViewer(msg.content, isDisappearing);
        }
    },
    
    async viewDisappearingImage(msgId) {
        // Buscar dados da mensagem antes de apagar para ter o UUID
        const msg = await TalkStorage.getMessage(msgId);
        if (!msg) return;

        // Exibir imagem
        this.openImageViewer(msg.content, true);
        
        // Se tiver UUID, enviar o recibo de leitura (E2EE)
        if (msg.msgId) {
            await TalkChat.sendAck(String(msg.fromId), msg.msgId, 'read');
        }
        
        // Marcar como visualizada e apagar
        await TalkStorage.deleteMessage(msgId);
        
        // Atualizar UI imediatamente (destinatário vê a mensagem de sumiu)
        const msgEl = document.querySelector(`[data-msg-id="${msgId}"]`);
        if (msgEl) {
            const bubble = msgEl.querySelector('.msg-bubble');
            if (bubble) {
                bubble.innerHTML = `<div class="msg-text msg-viewed">${TalkI18n.dictionary['msg_viewed'] || '📸 Foto visualizada e removida'}</div>`;
                bubble.classList.add('viewed-bubble');
                bubble.onclick = null; // Remove o evento de clique
                bubble.style.cursor = 'default';
            }
        }
    },
    
    async downloadFile(fileId, fileName) {
        if (!fileId) return;
        
        const file = await TalkStorage.getFile(fileId);
        if (!file) {
            TalkChat.showNotification(TalkI18n.dictionary['error_file_not_available'] || '❌ Arquivo não disponível', 'error');
            return;
        }
        
        const blob = TalkMedia.arrayBufferToBlob(file.data, file.type);
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = fileName || file.name;
        a.click();
        URL.revokeObjectURL(url);
    },
    
    showContactInfo() {
        const contact = TalkChat.state.activeContact;
        if (!contact) return;
        
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-box">
                <div class="modal-header">
                    <h3>🔍 Informações do Contato</h3>
                    <button onclick="this.closest('.modal-overlay').remove()">✕</button>
                </div>
                <div class="modal-body">
                    <div class="contact-detail-avatar">${contact.username.charAt(0).toUpperCase()}</div>
                    <h2>${TalkChat.escHtml(contact.username)}</h2>
                    <div class="fingerprint-display">
                        <label>🔑 Fingerprint de Segurança</label>
                        <div class="fingerprint-value">${TalkChat.escHtml(contact.fingerprint || 'N/D')}</div>
                        <p class="fingerprint-hint">Compare este código com seu contato para garantir que não há intermediários.</p>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn-danger" onclick="TalkUI.removeContact('${contact.id}')" data-i18n="confirm_remove_contact">Remover contato</button>
                    <button class="btn-primary" onclick="this.closest('.modal-overlay').remove()" data-i18n="btn_close">Fechar</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    },
    
    showTutorial() {
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-box" style="max-width:500px">
                <div class="modal-header">
                    <h3 data-i18n="tutorial_title">🚀 Guia GhostZap</h3>
                    <button onclick="this.closest('.modal-overlay').remove()">✕</button>
                </div>
                <div class="legal-modal-body" style="text-align:left">
                    <p data-i18n="tutorial_welcome">Bem-vindo ao <strong>GhostZap</strong>, o chat mais seguro que você já usou. Aqui o servidor não lê nada!</p>
                    
                    <h4 data-i18n="tutorial_e2ee_title">🔐 Criptografia Real (E2EE)</h4>
                    <p data-i18n="tutorial_e2ee_body">Suas mensagens são trancadas no seu aparelho antes de sair. Apenas o destinatário tem a chave para abrir.</p>
                    
                    <h4 data-i18n="tutorial_zero_title">👻 Zero-Knowledge</h4>
                    <p data-i18n="tutorial_zero_body">O servidor nunca vê sua senha ou suas mensagens. Zero rastros.</p>

                    <h4 data-i18n="tutorial_ai_title">🪄 IA: Correção e Tradução</h4>
                    <p data-i18n="tutorial_ai_body">Use a <strong>varinha mágica</strong> ao digitar: se estiver no modo PT, ela corrige seu português. Se estiver em EN, ES ou ZH, ela traduz o que você escreveu para esse idioma. Se receber algo em outro idioma, use o botão <strong>🪄 IA: Traduzir</strong> na bolha da mensagem.</p>

                    <h4 data-i18n="tutorial_lang_title">🌐 Idiomas</h4>
                    <p data-i18n="tutorial_lang_body">Escolha entre PT, EN, ES ou ZH no menu lateral. O idioma selecionado altera a interface e define para qual língua a <strong>varinha mágica</strong> irá traduzir suas mensagens.</p>
                    
                    <h4 data-i18n="tutorial_ttl_title">⏱️ Msg Temporárias</h4>
                    <p data-i18n="tutorial_ttl_body">No ícone de <strong>reloginho</strong>, você define quanto tempo a mensagem dura. Depois do tempo, ela some para sempre.</p>
                    
                    <h4 data-i18n="tutorial_master_reset_title">💥 Master Reset Automático</h4>
                    <p data-i18n="tutorial_master_reset_body">Nas configurações de segurança (ícone de engrenagem), você pode ativar o <strong>Auto-wipe</strong>. Se você ficar 6h, 12h ou 24h sem usar o app, ele apaga todo o histórico local e chaves por segurança.</p>
                    
                    <h4 data-i18n="tutorial_recovery_title">🔑 Recuperação de Conta</h4>
                    <p data-i18n="tutorial_recovery_body">Se o app for resetado ou você trocar de celular, use sua <strong>Frase de 12 palavras</strong> (gerada nas configurações) para restaurar sua identidade e voltar a conversar.</p>
 
                    <h4 data-i18n="tutorial_temp_photo_title">📸 Fotos Temporárias</h4>
                    <p data-i18n="tutorial_temp_photo_body">Envie fotos que o destinatário só pode ver <strong>uma única vez</strong>.</p>
                    
                    <h4 data-i18n="tutorial_pwa_title">📱 Como Instalar (PWA)</h4>
                    <p data-i18n="tutorial_pwa_body">Se você optou por <strong>não instalar</strong> no primeiro acesso e quer instalar agora:</p>
                    <ul>
                      <li data-i18n="tutorial_pwa_android"><strong>No Android/Chrome</strong>: Clique nos 3 pontinhos (⋮) e em <strong>Instalar Aplicativo</strong>.</li>
                      <li data-i18n="tutorial_pwa_ios"><strong>No iPhone/Safari</strong>: Clique no botão <strong>Compartilhar (↑)</strong> e depois em <strong>Adicionar à Tela de Início</strong>.</li>
                      <li data-i18n="tutorial_pwa_pc"><strong>No PC</strong>: Clique no ícone de <strong>instalação (🖥️+)</strong> no final da barra de endereços.</li>
                    </ul>
                    
                    <h4 data-i18n="tutorial_browser_title">🌐 Tudo no Browser</h4>
                    <p data-i18n="tutorial_browser_body">Seus dados ficam salvos apenas neste navegador (IndexedDB). Se apagar o cache do browser, as mensagens somem.</p>
                    
                    <div style="margin-top:20px; padding:14px; background:linear-gradient(135deg, rgba(56,189,248,0.1), rgba(15,23,42,0.6)); border:1px solid rgba(56,189,248,0.25); border-radius:14px; display:flex; justify-content:space-between; align-items:center; gap:12px;">
                        <div>
                            <div style="font-weight:700; font-size:13px; color:#fff;">🛡️ Central de Ajuda & Suporte</div>
                            <div style="font-size:11px; color:#94a3b8;">Tire dúvidas, veja status e abra chamados</div>
                        </div>
                        <a href="support.html" target="_blank" rel="noopener" style="background:#38bdf8; color:#020617; padding:8px 14px; border-radius:8px; font-weight:700; font-size:12px; text-decoration:none; white-space:nowrap; box-shadow:0 2px 8px rgba(56,189,248,0.3);">Abrir Suporte ↗</a>
                    </div>

                    <div style="margin-top:20px; padding:16px; background:rgba(56,189,248,0.05); border:1px solid rgba(56,189,248,0.15); border-radius:12px; text-align:center;">
                        <p style="font-size:13px; font-weight:600; margin-bottom:12px;" data-i18n="tutorial_share_title">📣 Gostou do GhostZap? Espalhe a palavra!</p>
                        <div style="display:flex; justify-content:center; gap:12px;">
                            <button onclick="shareApp('whatsapp')" class="btn-social whatsapp" style="width:40px; height:40px; border-radius:50%; border:none; cursor:pointer; background:#25d366; display:flex; align-items:center; justify-content:center;">
                                <svg width="22" height="22" fill="white" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.445 0 .081 5.363.079 11.967c0 2.111.551 4.171 1.597 6.014L0 24l6.166-1.617a11.827 11.827 0 005.883 1.553h.005c6.607 0 11.972-5.365 11.975-11.97.001-3.201-1.242-6.208-3.497-8.465z"></path></svg>
                            </button>
                            <button onclick="shareApp('facebook')" class="btn-social facebook" style="width:40px; height:40px; border-radius:50%; border:none; cursor:pointer; background:#1877f2; display:flex; align-items:center; justify-content:center;">
                                <svg width="24" height="24" fill="white" viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.469h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"></path></svg>
                            </button>
                            <button onclick="shareApp('twitter')" class="btn-social twitter" style="width:40px; height:40px; border-radius:50%; border:none; cursor:pointer; background:#000; display:flex; align-items:center; justify-content:center;">
                                <svg width="20" height="20" fill="white" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path></svg>
                            </button>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn-primary" style="width:100%" onclick="this.closest('.modal-overlay').remove()" data-i18n="btn_understood_all">Entendi tudo!</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        if (typeof TalkI18n !== "undefined") TalkI18n.applyTranslations();
    },

    async removeContact(contactId) {
        if (!confirm(TalkI18n.dictionary['confirm_remove_contact'] || 'Remover este contato?')) return;
        
        await fetch('api/contacts.php', {
            method:      'DELETE',
            credentials: 'include',
            headers:     { 'Content-Type': 'application/json' },
            body:        JSON.stringify({ contact_id: parseInt(contactId) }),
        });
        
        TalkChat.state.activeContact = null;
        TalkChat.renderEmptyState();
        await TalkChat.loadConversations();
        
        document.querySelector('.modal-overlay')?.remove();
        TalkChat.showNotification(TalkI18n.dictionary['notif_contact_removed'] || '✅ Contato removido', 'success');
    },
    
    showContactList() {
        // No mobile, mostrar lista ao invés do chat
        document.getElementById('sidebar')?.classList.remove('hidden-mobile');
        document.getElementById('chat-area-wrapper')?.classList.add('hidden-mobile');
    },

    showShareModal() {
        const url = 'https://4u.ia.br/app/zap';
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="share-card">
                <div class="share-header-icon" style="background:transparent; box-shadow:none;">
                    <img src="icons/icon-512.png" alt="GhostZap" style="width:100%; height:100%; border-radius:18px;">
                </div>
                <h3 data-i18n="share_modal_title">Convide seus amigos</h3>
                <p data-i18n="share_modal_body">Compartilhe a experiência de chat ultra-privado com quem você confia.</p>
                
                <div class="copy-link-area">
                    <input type="text" class="copy-link-text" value="${url}" readonly id="share-url-input">
                    <button class="btn-copy" onclick="TalkUI.copyShareLink()" data-i18n="btn_copy">Copiar</button>
                </div>
                
                <div class="social-grid">
                    <div class="social-btn-premium whatsapp" onclick="shareApp('whatsapp')">
                        <svg fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.445 0 .081 5.363.079 11.967c0 2.111.551 4.171 1.597 6.014L0 24l6.166-1.617a11.827 11.827 0 005.883 1.553h.005c6.607 0 11.972-5.365 11.975-11.97.001-3.201-1.242-6.208-3.497-8.465z"></path></svg>
                        <span>WhatsApp</span>
                    </div>
                    <div class="social-btn-premium facebook" onclick="shareApp('facebook')">
                        <svg fill="currentColor" viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.469h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"></path></svg>
                        <span>Facebook</span>
                    </div>
                    <div class="social-btn-premium twitter" onclick="shareApp('twitter')">
                        <svg fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path></svg>
                        <span>X / Twitter</span>
                    </div>
                </div>
                
                <button class="btn-text" style="margin-top:24px; width:100%" onclick="this.closest('.modal-overlay').remove()">Agora não</button>
            </div>
        `;
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
        document.body.appendChild(modal);
        TalkI18n.applyTranslations();
    },

    copyShareLink() {
        const input = document.getElementById('share-url-input');
        input.select();
        document.execCommand('copy');
        TalkChat.showNotification('✅ Link copiado para a área de transferência!', 'success');
    },

    // ─────────────────────────────────────────────────────────────
    // DEEP LINK: QR Code de Perfil Pessoal
    // ─────────────────────────────────────────────────────────────

    /**
     * Exibe o QR Code do link pessoal do usuário (equivalente ao wa.me)
     * Qualquer pessoa que escanear já abre o GhostZap direto na conversa
     */
    showProfileQR() {
        const user = TalkChat.state.currentUser;
        if (!user) return;

        const deepLink = `https://4u.ia.br/app/zap?add=${encodeURIComponent(user.username)}`;

        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-box" style="max-width:340px; text-align:center;">
                <div class="modal-header">
                    <h3>📲 Meu Link de Contato</h3>
                    <button onclick="this.closest('.modal-overlay').remove()">✕</button>
                </div>
                <div style="padding: 0 24px 24px;">
                    <p style="color:var(--text-secondary);font-size:13px;margin-bottom:20px;">
                        Compartilhe este QR Code. Quem escanear já abre o GhostZap direto no chat com você.
                    </p>
                    <div id="qr-canvas-wrap" style="
                        background: white;
                        border-radius: 16px;
                        padding: 20px;
                        display: inline-block;
                        margin-bottom: 20px;
                        box-shadow: 0 8px 32px rgba(0,0,0,0.3);
                    ">
                        <div id="qr-loading" style="width:200px;height:200px;display:flex;align-items:center;justify-content:center;color:#666;">
                            ⏳ Gerando...
                        </div>
                    </div>
                    <div style="
                        background: rgba(255,255,255,0.05);
                        border: 1px solid var(--border);
                        border-radius: 10px;
                        padding: 10px 14px;
                        font-size: 11px;
                        color: var(--text-muted);
                        word-break: break-all;
                        margin-bottom: 16px;
                        font-family: monospace;
                    ">${deepLink}</div>
                    <button class="btn-primary" style="width:100%;" onclick="
                        navigator.clipboard?.writeText('${deepLink}').then(() => {
                            TalkChat.showNotification(TalkI18n.dictionary['notif_link_copied'] || '✅ Link copiado!', 'success');
                        });
                    ">📋 Copiar Link</button>
                </div>
            </div>
        `;
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
        document.body.appendChild(modal);

        // Carregar qrcodejs (biblioteca nativa para browser) dinamicamente
        const loadAndRender = () => TalkUI._renderQR(deepLink);
        if (!window.QRCode) {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js';
            script.onload = loadAndRender;
            script.onerror = () => {
                const wrap = document.getElementById('qr-canvas-wrap');
                if (wrap) wrap.innerHTML = `<p style="color:#f87171;font-size:13px;">${TalkI18n.dictionary['error_qr_lib'] || 'Erro ao carregar lib de QR Code. Verifique sua conexão.'}</p>`;
            };
            document.head.appendChild(script);
        } else {
            loadAndRender();
        }
    },

    _renderQR(url) {
        const wrap = document.getElementById('qr-canvas-wrap');
        if (!wrap) return;
        // Limpar o placeholder de "Gerando..."
        wrap.innerHTML = '';
        // qrcodejs instancia em cima de um div e gera canvas+img internamente
        try {
            new QRCode(wrap, {
                text:   url,
                width:  200,
                height: 200,
                colorDark:  '#000000',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.M,
            });
        } catch (e) {
            wrap.innerHTML = `<p style="color:#f87171;font-size:13px;">${(TalkI18n.dictionary['error_qr_gen'] || 'Erro ao gerar QR: {error}').replace('{error}', e.message)}</p>`;
        }
    },

    // ─────────────────────────────────────────────────────────────
    // DEEP LINK: Adicionar contato por username (busca direta)
    // ─────────────────────────────────────────────────────────────

    /**
     * Busca usuário por username e abre conversa diretamente
     * Usado no modal de busca de contato
     */
    async addContactByUsername(username) {
        if (!username) return;
        try {
            const res  = await fetch(`api/users.php?username=${encodeURIComponent(username.trim())}`, { credentials: 'include' });
            const data = await res.json();
            if (!res.ok || data.error || !data.id) {
                TalkChat.showNotification(TalkI18n.dictionary['error_user_not_found'] || '❌ Usuário não encontrado.', 'error');
                return;
            }
            document.querySelector('.modal-overlay')?.remove();
            const msg = (TalkI18n.dictionary['notif_opening_conv'] || '👋 Abrindo conversa com {user}...').replace('{user}', data.username);
            TalkChat.showNotification(msg, 'success');
            await TalkChat.openConversation({
                id:          String(data.id),
                username:    data.username,
                publicKey:   data.public_key || '',
                fingerprint: data.fingerprint || '',
            });
        } catch (e) {
            TalkChat.showNotification(TalkI18n.dictionary['error_conn_generic'] || '❌ Erro de conexão.', 'error');
        }
    },

    // ─────────────────────────────────────────────────────────────
    // IA — OpenAI Integration
    // ─────────────────────────────────────────────────────────────

    async aiAction() {
        const input = document.getElementById('message-input');
        const btn = document.getElementById('btn-ai-wizard');
        const text = input.value.trim();
        if (!text) return;

        btn.classList.add('ai-loading');
        TalkChat.showNotification(TalkI18n.dictionary['ai_correcting'] || '🪄 IA processando...', 'info');

        try {
            const isPt = TalkI18n.currentLang === 'pt';
            const res = await fetch('api/ai.php', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + (localStorage.getItem('keepai_token') || '')
                },
                body: JSON.stringify({
                    text: text,
                    mode: isPt ? 'correct' : 'translate',
                    targetLang: TalkI18n.currentLang
                })
            });

            if (res.status === 401) {
                TalkChat.showNotification('Autenticação unificada necessária.', 'error');
                this.showLoginModal();
                return;
            }

            if (res.status === 402) {
                TalkChat.showNotification('Saldo de créditos unificados insuficiente.', 'error');
                this.showRechargeModal();
                return;
            }

            const data = await res.json();
            if (data.result) {
                input.value = data.result;
                this.autoResize(input);
                if (data.credits_remaining !== undefined) {
                    this.updateCredits(data.credits_remaining);
                }
            } else {
                throw new Error(data.error);
            }
        } catch (e) {
            TalkChat.showNotification((TalkI18n.dictionary['ai_error'] || '❌ Erro: ') + e.message, 'error');
        } finally {
            btn.classList.remove('ai-loading');
        }
    },

    async aiTranslateMessage(msgId, btn) {
        const bubble = btn.closest('.msg-bubble');
        const textEl = bubble.querySelector('.msg-text');
        if (!textEl) return;

        const originalText = textEl.innerText;
        btn.classList.add('ai-loading');
        btn.disabled = true;

        try {
            const res = await fetch('api/ai.php', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + (localStorage.getItem('keepai_token') || '')
                },
                body: JSON.stringify({
                    text: originalText,
                    mode: 'translate',
                    targetLang: TalkI18n.currentLang
                })
            });

            if (res.status === 401) {
                TalkChat.showNotification('Autenticação unificada necessária.', 'error');
                btn.classList.remove('ai-loading');
                btn.disabled = false;
                this.showLoginModal();
                return;
            }

            if (res.status === 402) {
                TalkChat.showNotification('Saldo de créditos unificados insuficiente.', 'error');
                btn.classList.remove('ai-loading');
                btn.disabled = false;
                this.showRechargeModal();
                return;
            }

            const data = await res.json();
            if (data.result) {
                const transDiv = document.createElement('div');
                transDiv.className = 'msg-ai-translate';
                transDiv.setAttribute('data-label', TalkI18n.dictionary['ai_translation_label'] || '🪄 AI Translation');
                transDiv.innerText = data.result;
                bubble.insertBefore(transDiv, bubble.querySelector('.msg-meta'));
                btn.remove(); // Remove o botão após traduzir
                if (data.credits_remaining !== undefined) {
                    this.updateCredits(data.credits_remaining);
                }
            } else {
                throw new Error(data.error);
            }
        } catch (e) {
            TalkChat.showNotification((TalkI18n.dictionary['ai_error'] || '❌ Erro: ') + e.message, 'error');
            btn.classList.remove('ai-loading');
            btn.disabled = false;
        }
    },

    // ─────────────────────────────────────────────────────────────
    // Voice Recording & Transcription
    // ─────────────────────────────────────────────────────────────
    
    _recorder: null,
    _audioChunks: [],
    _isRecording: false,
    _recordingStartTime: 0,
    _recordingInterval: null,

    async toggleVoiceRecording() {
        if (this._isRecording) {
            this.stopRecording();
        } else {
            this.startRecording();
        }
    },

    async startRecording() {
        const panel = document.getElementById('attachment-options');
        if (panel) panel.style.display = 'none';

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this._recorder = new MediaRecorder(stream);
            this._audioChunks = [];
            
            const btnVoice = document.getElementById('btn-voice');
            const btnAttach = document.getElementById('btn-attach');
            const timerEl = document.getElementById('voice-timer');
            const inputEl = document.getElementById('message-input');

            if (btnVoice) btnVoice.classList.add('recording-pulse');
            
            if (btnAttach) {
                btnAttach.classList.add('recording-pulse');
                btnAttach.style.color = '#f87171';
                btnAttach.onclick = (e) => { e.stopPropagation(); this.stopRecording(); };
                btnAttach.title = "Parar Gravação (Máx 1min)";
            }

            if (timerEl) {
                timerEl.style.display = 'block';
                timerEl.textContent = '00:00';
            }
            if (inputEl) inputEl.style.opacity = '0.5';

            this._isRecording = true;
            this._recordingStartTime = Date.now();
            
            this._recordingInterval = setInterval(() => {
                const elapsed = Math.floor((Date.now() - this._recordingStartTime) / 1000);
                const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
                const secs = (elapsed % 60).toString().padStart(2, '0');
                if (timerEl) timerEl.textContent = `${mins}:${secs}`;

                if (elapsed >= 60) {
                    this.stopRecording();
                }
            }, 1000);

            this._recorder.ondataavailable = (e) => {
                if (e.data.size > 0) this._audioChunks.push(e.data);
            };

            this._recorder.onstop = async () => {
                clearInterval(this._recordingInterval);
                const audioBlob = new Blob(this._audioChunks, { type: 'audio/webm' });
                
                if (btnVoice) btnVoice.classList.remove('recording-pulse');
                if (timerEl) timerEl.style.display = 'none';
                if (inputEl) inputEl.style.opacity = '1';

                if (btnAttach) {
                    btnAttach.classList.remove('recording-pulse');
                    btnAttach.style.color = '';
                    btnAttach.onclick = () => TalkUI.toggleAttachments();
                    btnAttach.title = "Anexar";
                }

                this._isRecording = false;
                stream.getTracks().forEach(track => track.stop());

                await this.processVoiceBlob(audioBlob);
            };

            this._recorder.start();
        } catch (err) {
            console.error('Erro ao acessar microfone:', err);
            TalkChat.showNotification('❌ Erro ao acessar microfone: ' + err.message, 'error');
        }
    },

    stopRecording() {
        if (this._recorder && this._isRecording) {
            this._recorder.stop();
        }
    },

    async processVoiceBlob(blob) {
        const btn = document.getElementById('btn-voice');
        btn.classList.add('ai-loading');
        TalkChat.showNotification('🪄 Transcrevendo áudio...', 'info');

        try {
            const formData = new FormData();
            formData.append('audio', blob, 'recording.webm');
            formData.append('mode', 'transcribe');

            const res = await fetch('api/ai.php', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + (localStorage.getItem('keepai_token') || '')
                },
                body: formData
            });

            if (res.status === 401) {
                TalkChat.showNotification('Autenticação unificada necessária.', 'error');
                btn.classList.remove('ai-loading');
                this.showLoginModal();
                return;
            }

            if (res.status === 402) {
                TalkChat.showNotification('Saldo de créditos unificados insuficiente.', 'error');
                btn.classList.remove('ai-loading');
                this.showRechargeModal();
                return;
            }

            const data = await res.json();
            if (data.result) {
                const ttl = parseInt(document.getElementById('ttl-select')?.value || '0');
                await TalkChat.sendVoiceMessage(data.result, ttl);
                if (data.credits_remaining !== undefined) {
                    this.updateCredits(data.credits_remaining);
                }
            } else {
                throw new Error(data.error || 'Erro na transcrição');
            }
        } catch (e) {
            console.error('Erro na transcrição:', e);
            TalkChat.showNotification('❌ Erro na IA: ' + e.message, 'error');
        } finally {
            btn.classList.remove('ai-loading');
        }
    },
};
