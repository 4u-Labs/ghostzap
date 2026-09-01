// ============================================================
// storage.js — TalkMotion Secure Chat
// Armazenamento local usando IndexedDB
// TODO histórico de mensagens fica APENAS no navegador
// ============================================================

'use strict';

const TalkStorage = (() => {
    
    const DB_NAME    = 'GhostZap';
    const DB_VERSION = 3;   // v3: adiciona índice msgId para rastrear status ✓✓
    let   db         = null;

    // Estado de Criptografia em Repouso & Modo Volátil (RAM-Only)
    let volatileMode = true; // Habilitado por padrão (Zero Disk)
    let storageKey   = null;
    const volatileStore = {
        conversations: new Map(),
        messages:      new Map(),
        files:         new Map()
    };

    function setVolatileMode(enable) {
        volatileMode = Boolean(enable);
        try {
            sessionStorage.setItem('ghostzap_volatile_mode', volatileMode ? '1' : '0');
        } catch (e) {}
    }

    function isVolatileMode() {
        try {
            const saved = sessionStorage.getItem('ghostzap_volatile_mode');
            if (saved !== null) {
                volatileMode = (saved === '1');
            }
        } catch (e) {}
        return volatileMode;
    }

    function setStorageKey(key) {
        storageKey = key;
    }

    function getStorageKey() {
        return storageKey;
    }

    // --------------------------------------------------------
    // Inicialização do IndexedDB
    // --------------------------------------------------------

    /**
     * Abre e inicializa o banco IndexedDB
     * @returns {Promise<IDBDatabase>}
     */
    async function openDB() {
        if (db) return db;
        
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            
            // Criar stores na primeira abertura ou upgrade
            request.onupgradeneeded = (event) => {
                const idb = event.target.result;
                
                // Store de chaves criptográficas do usuário
                if (!idb.objectStoreNames.contains('keys')) {
                    idb.createObjectStore('keys', { keyPath: 'id' });
                }
                
                // Store de conversas
                if (!idb.objectStoreNames.contains('conversations')) {
                    const convStore = idb.createObjectStore('conversations', { keyPath: 'id' });
                    convStore.createIndex('participants', 'participants', { unique: false });
                }
                
                // Store de mensagens
                if (!idb.objectStoreNames.contains('messages')) {
                    const msgStore = idb.createObjectStore('messages', { 
                        keyPath: 'id', 
                        autoIncrement: true 
                    });
                    msgStore.createIndex('conversationId', 'conversationId', { unique: false });
                    msgStore.createIndex('timestamp', 'timestamp', { unique: false });
                    msgStore.createIndex('msgId', 'msgId', { unique: false });
                } else {
                    // Upgrade v2 -> v3: adicionar índice msgId se não existir
                    const tx       = event.target.transaction;
                    const msgStore = tx.objectStore('messages');
                    if (!msgStore.indexNames.contains('msgId')) {
                        msgStore.createIndex('msgId', 'msgId', { unique: false });
                    }
                }
                
                // Store de arquivos (binários criptografados)
                if (!idb.objectStoreNames.contains('files')) {
                    idb.createObjectStore('files', { keyPath: 'id' });
                }
                
                // Store de configurações do app
                if (!idb.objectStoreNames.contains('settings')) {
                    idb.createObjectStore('settings', { keyPath: 'key' });
                }
            };
            
            request.onsuccess = (event) => {
                db = event.target.result;
                resolve(db);
            };
            
            request.onerror = () => reject(request.error);
        });
    }

    // --------------------------------------------------------
    // Operações genéricas
    // --------------------------------------------------------

    async function put(storeName, value) {
        const idb = await openDB();
        return new Promise((resolve, reject) => {
            const tx  = idb.transaction(storeName, 'readwrite');
            const req = tx.objectStore(storeName).put(value);
            req.onsuccess = () => resolve(req.result);
            req.onerror   = () => reject(req.error);
        });
    }

    async function get(storeName, key) {
        const idb = await openDB();
        return new Promise((resolve, reject) => {
            const tx  = idb.transaction(storeName, 'readonly');
            const req = tx.objectStore(storeName).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror   = () => reject(req.error);
        });
    }

    async function getAll(storeName) {
        const idb = await openDB();
        return new Promise((resolve, reject) => {
            const tx  = idb.transaction(storeName, 'readonly');
            const req = tx.objectStore(storeName).getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror   = () => reject(req.error);
        });
    }

    async function deleteRecord(storeName, key) {
        const idb = await openDB();
        return new Promise((resolve, reject) => {
            const tx  = idb.transaction(storeName, 'readwrite');
            const req = tx.objectStore(storeName).delete(key);
            req.onsuccess = () => resolve();
            req.onerror   = () => reject(req.error);
        });
    }

    // --------------------------------------------------------
    // Gerenciamento de Chaves Criptográficas
    // --------------------------------------------------------

    /**
     * Salva as chaves criptográficas do usuário no IndexedDB
     * A chave privada NUNCA sai do dispositivo
     * @param {string} userId
     * @param {CryptoKey} publicKey
     * @param {CryptoKey} privateKey
     */
    async function saveKeyPair(userId, publicKey, privateKey) {
        // Armazenar CryptoKey diretamente (não extrai — mais seguro)
        await put('keys', {
            id:         `keys_${userId}`,
            userId,
            publicKey,
            privateKey,
            createdAt:  new Date().toISOString(),
        });
    }

    /**
     * Recupera par de chaves do usuário
     * @param {string} userId
     * @returns {Promise<{publicKey, privateKey}|null>}
     */
    async function getKeyPair(userId) {
        const record = await get('keys', `keys_${userId}`);
        return record || null;
    }

    // --------------------------------------------------------
    // Conversas
    // --------------------------------------------------------

    /**
     * Cria ou atualiza conversa
     * @param {string} myId
     * @param {string} contactId
     * @param {string} contactUsername
     * @param {string} contactPublicKey
     */
    async function saveConversation(myId, contactId, contactUsername, contactPublicKey, contactFingerprint) {
        const id = getConversationId(myId, contactId);
        
        let existing = null;
        if (isVolatileMode()) {
            existing = volatileStore.conversations.get(id);
        } else {
            existing = await get('conversations', id);
        }
        
        const conversation = {
            id,
            participants:       [String(myId), String(contactId)],
            contactId:          String(contactId),
            contactUsername:    contactUsername || existing?.contactUsername || 'Contato',
            contactPublicKey:   contactPublicKey || existing?.contactPublicKey || '',
            contactFingerprint: contactFingerprint || existing?.contactFingerprint || '',
            createdAt:          existing?.createdAt || new Date().toISOString(),
            updatedAt:          new Date().toISOString(),
            lastMessage:        existing?.lastMessage || null,
            unreadCount:        existing?.unreadCount || 0,
        };
        
        if (isVolatileMode()) {
            volatileStore.conversations.set(conversation.id, conversation);
            return conversation;
        }

        await put('conversations', conversation);
        return conversation;
    }

    /**
     * Retorna todas as conversas do usuário
     * @returns {Promise<Array>}
     */
    async function getConversations() {
        if (isVolatileMode()) {
            const list = Array.from(volatileStore.conversations.values());
            return list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        }

        const all = await getAll('conversations') || [];
        if (storageKey && typeof TalkCrypto !== 'undefined') {
            for (const c of all) {
                if (c.lastMessage && typeof c.lastMessage.content === 'string' && c.lastMessage.content.startsWith('{"_enc":1')) {
                    c.lastMessage.content = await TalkCrypto.decryptStorageData(c.lastMessage.content, storageKey) || '[Mensagem]';
                }
            }
        }
        return all.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    }

    /**
     * Gera ID único para conversa (ordenado para ser simétrico)
     */
    function getConversationId(userA, userB) {
        const ids = [String(userA), String(userB)].sort();
        return `conv_${ids[0]}_${ids[1]}`;
    }

    // --------------------------------------------------------
    // Mensagens
    // --------------------------------------------------------

    /**
     * Armazena mensagem no IndexedDB (ou na memória RAM se modo volátil ativo)
     * Aplica criptografia em repouso se chave de storage configurada
     * @param {object} message
     * @returns {Promise<number>} ID da mensagem salva
     */
    async function saveMessage(message) {
        const isVolatile = isVolatileMode();
        
        // Se modo volátil estiver ativo, armazena APENAS na memória RAM
        if (isVolatile) {
            const tempId = Date.now() + Math.floor(Math.random() * 10000);
            const msgRecord = {
                id:             tempId,
                conversationId: message.conversationId,
                fromId:         String(message.fromId),
                fromUsername:   message.fromUsername,
                toId:           String(message.toId),
                type:           message.type || 'text',
                content:        message.content,
                fileId:         message.fileId || null,
                fileName:       message.fileName || null,
                fileSize:       message.fileSize || null,
                timestamp:      message.timestamp || new Date().toISOString(),
                status:         message.status || 'sent',
                expiresAt:      message.expiresAt || null,
                isTemporary:    message.isTemporary || false,
                viewed:         message.viewed || false,
                isMine:         message.isMine || false,
                msgId:          message.msgId || null
            };
            
            volatileStore.messages.set(tempId, msgRecord);
            
            const isMine = Boolean(message.isMine);
            const contactId = isMine ? String(message.toId) : String(message.fromId);
            const contactUsername = isMine ? (message.toUsername || 'Contato') : (message.fromUsername || 'Contato');

            let conv = volatileStore.conversations.get(message.conversationId);
            if (!conv) {
                conv = {
                    id: message.conversationId,
                    participants: [String(message.fromId), String(message.toId)],
                    contactId: contactId,
                    contactUsername: contactUsername,
                    unreadCount: 0,
                    createdAt: msgRecord.timestamp
                };
            }
            conv.contactId = contactId;
            conv.contactUsername = contactUsername;
            conv.lastMessage = {
                content:   message.type === 'text' ? message.content : `[${message.type}]`,
                timestamp: msgRecord.timestamp,
                fromId:    String(message.fromId)
            };
            conv.updatedAt = msgRecord.timestamp;
            if (!message.isMine) conv.unreadCount = (conv.unreadCount || 0) + 1;
            volatileStore.conversations.set(message.conversationId, conv);
            
            return tempId;
        }

        const idb = await openDB();
        
        // Aplicar criptografia em repouso se chave ativa
        let storedContent = message.content;
        let storedLastContent = message.type === 'text' ? message.content : `[${message.type}]`;
        if (storageKey && typeof TalkCrypto !== 'undefined') {
            try {
                storedContent = await TalkCrypto.encryptStorageData(message.content, storageKey);
                storedLastContent = await TalkCrypto.encryptStorageData(storedLastContent, storageKey);
            } catch (e) {
                console.warn('Falha na criptografia de repouso:', e);
            }
        }
        
        return new Promise((resolve, reject) => {
            const tx = idb.transaction(['messages', 'conversations'], 'readwrite');
            
            const msgRecord = {
                conversationId: message.conversationId,
                fromId:         message.fromId,
                fromUsername:   message.fromUsername,
                toId:           message.toId,
                type:           message.type || 'text',
                content:        storedContent,
                fileId:         message.fileId || null,
                fileName:       message.fileName || null,
                fileSize:       message.fileSize || null,
                timestamp:      message.timestamp || new Date().toISOString(),
                status:         message.status || 'sent',
                expiresAt:      message.expiresAt || null,
                isTemporary:    message.isTemporary || false,
                viewed:         message.viewed || false,
                isMine:         message.isMine || false,
                msgId:          message.msgId || null
            };
            
            const addReq = tx.objectStore('messages').add(msgRecord);
            
            addReq.onsuccess = () => {
                const convStore = tx.objectStore('conversations');
                const getConv   = convStore.get(message.conversationId);
                
                getConv.onsuccess = () => {
                    if (getConv.result) {
                        const conv = getConv.result;
                        conv.lastMessage  = {
                            content:   storedLastContent,
                            timestamp: msgRecord.timestamp,
                            fromId:    message.fromId,
                        };
                        conv.updatedAt = msgRecord.timestamp;
                        if (!message.isMine) {
                            conv.unreadCount = (conv.unreadCount || 0) + 1;
                        }
                        convStore.put(conv);
                    }
                };
                
                resolve(addReq.result);
            };
            
            addReq.onerror = () => reject(addReq.error);
        });
    }

    /**
     * Busca todas as mensagens de uma conversa (decifra em memória se necessário)
     * @param {string} conversationId
     * @returns {Promise<Array>}
     */
    async function getMessages(conversationId) {
        if (isVolatileMode()) {
            const now = new Date();
            const list = [];
            for (const msg of volatileStore.messages.values()) {
                if (msg.conversationId === conversationId) {
                    if (!msg.expiresAt || new Date(msg.expiresAt) > now) {
                        list.push({ ...msg });
                    }
                }
            }
            return list.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        }

        const idb = await openDB();
        
        return new Promise((resolve, reject) => {
            const tx      = idb.transaction('messages', 'readonly');
            const store   = tx.objectStore('messages');
            const index   = store.index('conversationId');
            const request = index.getAll(conversationId);
            
            request.onsuccess = async () => {
                const messages = request.result || [];
                const now   = new Date();
                const valid = messages.filter(msg => {
                    if (!msg.expiresAt) return true;
                    return new Date(msg.expiresAt) > now;
                });
                
                // Decifrar em memória se criptografia de repouso ativa
                if (storageKey && typeof TalkCrypto !== 'undefined') {
                    for (const m of valid) {
                        if (typeof m.content === 'string' && m.content.startsWith('{"_enc":1')) {
                            m.content = await TalkCrypto.decryptStorageData(m.content, storageKey) || '[Erro ao decifrar]';
                        }
                    }
                }
                
                resolve(valid.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)));
            };
            
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Apaga todas as mensagens de uma conversa (e arquivos associados)
     * @param {string} conversationId
     */
    async function deleteConversation(conversationId) {
        // Limpar da memória volátil
        if (volatileStore.conversations.has(conversationId)) {
            volatileStore.conversations.delete(conversationId);
        }
        for (const [id, msg] of volatileStore.messages.entries()) {
            if (msg.conversationId === conversationId) {
                volatileStore.messages.delete(id);
            }
        }

        const idb = await openDB();
        
        return new Promise((resolve, reject) => {
            const tx       = idb.transaction(['messages', 'conversations', 'files'], 'readwrite');
            const msgStore = tx.objectStore('messages');
            const index    = msgStore.index('conversationId');
            
            const cursor = index.openCursor(IDBKeyRange.only(conversationId));
            
            cursor.onsuccess = (event) => {
                const c = event.target.result;
                if (c) {
                    if (c.value.fileId) {
                        tx.objectStore('files').delete(c.value.fileId);
                    }
                    c.delete();
                    c.continue();
                }
            };
            
            tx.objectStore('conversations').delete(conversationId);
            
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
        });
    }

    /**
     * Apaga TODAS as conversas e dados locais (Wipe Total)
     */
    async function deleteAllConversations() {
        // Limpar memória volátil
        volatileStore.conversations.clear();
        volatileStore.messages.clear();
        volatileStore.files.clear();

        const idb = await openDB();
        
        return new Promise((resolve, reject) => {
            const tx = idb.transaction(['messages', 'conversations', 'files'], 'readwrite');
            
            tx.objectStore('messages').clear();
            tx.objectStore('conversations').clear();
            tx.objectStore('files').clear();
            
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
        });
    }

    /**
     * Marca conversa como lida (zera unreadCount)
     */
    async function markConversationRead(conversationId) {
        if (isVolatileMode()) {
            const conv = volatileStore.conversations.get(conversationId);
            if (conv) {
                conv.unreadCount = 0;
                volatileStore.conversations.set(conversationId, conv);
            }
            return;
        }

        const conv = await get('conversations', conversationId);
        if (conv) {
            conv.unreadCount = 0;
            await put('conversations', conv);
        }
    }

    /**
     * Obtém mensagem individual (descriptografa se necessário e busca em RAM se volátil)
     * @param {number|string} id
     */
    async function getMessage(id) {
        const numId = Number(id);
        if (isVolatileMode()) {
            return volatileStore.messages.get(numId) || null;
        }

        const msg = await get('messages', numId);
        if (!msg) return null;

        if (storageKey && typeof TalkCrypto !== 'undefined' && typeof msg.content === 'string' && msg.content.startsWith('{"_enc":1')) {
            try {
                msg.content = await TalkCrypto.decryptStorageData(msg.content, storageKey) || msg.content;
            } catch (e) {}
        }
        return msg;
    }

    /**
     * Apaga mensagem individual
     * @param {number|string} messageId
     */
    async function deleteMessage(messageId) {
        const numId = Number(messageId);
        if (isVolatileMode()) {
            volatileStore.messages.delete(numId);
            return;
        }
        const msg = await get('messages', numId);
        if (msg?.fileId) {
            await deleteRecord('files', msg.fileId);
        }
        await deleteRecord('messages', numId);
    }

    /**
     * Limpa mensagens expiradas de todas as conversas
     */
    async function cleanExpiredMessages() {
        if (isVolatileMode()) {
            const now = new Date().toISOString();
            for (const [id, msg] of volatileStore.messages.entries()) {
                if (msg.expiresAt && msg.expiresAt < now) {
                    if (msg.fileId) volatileStore.files.delete(msg.fileId);
                    volatileStore.messages.delete(id);
                }
            }
            return;
        }

        const idb = await openDB();
        
        return new Promise((resolve) => {
            const tx    = idb.transaction(['messages', 'files'], 'readwrite');
            const store = tx.objectStore('messages');
            const now   = new Date().toISOString();
            
            const cursor = store.openCursor();
            cursor.onsuccess = (event) => {
                const c = event.target.result;
                if (c) {
                    if (c.value.expiresAt && c.value.expiresAt < now) {
                        if (c.value.fileId) {
                            tx.objectStore('files').delete(c.value.fileId);
                        }
                        c.delete();
                    }
                    c.continue();
                }
            };
            
            tx.oncomplete = () => resolve();
        });
    }

    // --------------------------------------------------------
    // Arquivos
    // --------------------------------------------------------

    /**
     * Salva arquivo (blob) no IndexedDB (ou RAM se volátil)
     * @param {string} fileId
     * @param {ArrayBuffer} data dados do arquivo (criptografados ou descriptografados)
     * @param {object} meta metadados do arquivo
     */
    async function saveFile(fileId, data, meta = {}) {
        if (isVolatileMode()) {
            volatileStore.files.set(fileId, {
                id:        fileId,
                data,
                name:      meta.name || 'arquivo',
                type:      meta.type || 'application/octet-stream',
                size:      meta.size || data.byteLength,
                savedAt:   new Date().toISOString(),
            });
            return;
        }

        await put('files', {
            id:        fileId,
            data,
            name:      meta.name || 'arquivo',
            type:      meta.type || 'application/octet-stream',
            size:      meta.size || data.byteLength,
            savedAt:   new Date().toISOString(),
        });
    }

    /**
     * Recupera arquivo do IndexedDB (ou RAM se volátil)
     * @param {string} fileId
     * @returns {Promise<{data, name, type}|null>}
     */
    async function getFile(fileId) {
        if (isVolatileMode()) {
            return volatileStore.files.get(fileId) || null;
        }
        return get('files', fileId);
    }

    // --------------------------------------------------------
    // Configurações
    // --------------------------------------------------------

    async function setSetting(key, value) {
        await put('settings', { key, value });
    }

    async function getSetting(key, defaultValue = null) {
        const record = await get('settings', key);
        return record ? record.value : defaultValue;
    }

    /**
     * Atualiza o status de uma mensagem pelo seu msgId (UUID)
     * Status: 'sent' → 'delivered' → 'read'
     * @param {string} msgId UUID da mensagem
     * @param {string} status novo status
     */
    async function updateMessageStatus(msgId, status) {
        if (!msgId) return;
        const idb = await openDB();
        return new Promise((resolve) => {
            const tx    = idb.transaction('messages', 'readwrite');
            const store = tx.objectStore('messages');
            const idx   = store.index('msgId');
            const req   = idx.openCursor(IDBKeyRange.only(msgId));

            req.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    // Só avança no status (nunca volta)
                    const order = { sending: 0, sent: 1, received: 1, delivered: 2, read: 3 };
                    if ((order[status] || 0) >= (order[cursor.value.status] || 0)) {
                        cursor.update({ ...cursor.value, status });
                    }
                    cursor.continue();
                }
            };
            tx.oncomplete = () => resolve();
            tx.onerror    = () => resolve(); // não crasha se não achar
        });
    }

    // API pública
    return {
        openDB,
        saveKeyPair,
        getKeyPair,
        saveConversation,
        getConversations,
        getConversationId,
        saveMessage,
        getMessages,
        getMessage,
        deleteConversation,
        deleteAllConversations,
        markConversationRead,
        deleteMessage,
        cleanExpiredMessages,
        saveFile,
        getFile,
        setSetting,
        getSetting,
        updateMessageStatus,
        setVolatileMode,
        isVolatileMode,
        setStorageKey,
        getStorageKey,
    };

})();
