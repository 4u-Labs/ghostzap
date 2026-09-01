/**
 * applock.js — GhostZap Secure Chat
 * Camada 2 de Proteção: Bloqueio por Inatividade e Biometria
 */

'use strict';

const AppLock = (() => {
    const SETTINGS_KEY = 'ghostzap_lock_settings';
    const STATE_KEY = 'ghostzap_lock_state';

    let inactivityTimer = null;
    let isLocked = false;

    // Configurações padrão
    const config = {
        enabled: false,
        timeout: 5, // minutos
        useBiometrics: false,
        pinHash: null, // SHA-256 do PIN
        duressPinHash: null, // SHA-256 do PIN de Pânico/Coação
        volatileMode: true, // Modo RAM-Only HABILITADO por padrão (Zero Disk)
        screenPrivacy: true, // Escudo de privacidade no multitarefa
        masterReset: 24, // Auto-wipe padrão: 24 horas de inatividade
        lastActivity: Date.now()
    };

    /**
     * Inicializa o sistema de bloqueio
     */
    async function init() {
        loadSettings();
        
        // Sincronizar Modo Volátil com TalkStorage
        if (typeof TalkStorage !== 'undefined') {
            TalkStorage.setVolatileMode(config.volatileMode);
        }

        // Inicializar Escudo de Privacidade de Tela
        if (config.screenPrivacy) {
            setupScreenPrivacyShield();
        }

        if (config.enabled) {
            resetInactivityTimer();
            setupActivityListeners();
            
            // Se o estado anterior era bloqueado, bloqueia agora
            if (sessionStorage.getItem(STATE_KEY) === 'locked') {
                lock();
            }
        }

        // Verificar Master Reset na inicialização e periodicamente
        checkMasterReset();
        setInterval(checkMasterReset, 60000); // Check a cada minuto
    }

    /**
     * Carrega configurações do localStorage
     */
    function loadSettings() {
        const saved = localStorage.getItem(SETTINGS_KEY);
        if (saved) {
            try {
                Object.assign(config, JSON.parse(saved));
            } catch (e) {
                console.error('Erro ao carregar configurações de bloqueio:', e);
            }
        } else {
            saveSettings();
        }
    }

    /**
     * Salva as configurações atuais
     */
    function saveSettings() {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(config));
    }

    /**
     * Listeners para detectar atividade do usuário
     */
    function setupActivityListeners() {
        const events = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart'];
        events.forEach(name => {
            document.addEventListener(name, resetInactivityTimer, true);
        });
    }

    /**
     * Reseta o cronômetro de inatividade
     */
    function resetInactivityTimer() {
        if (isLocked) return;
        
        if (inactivityTimer) clearTimeout(inactivityTimer);
        
        if (config.enabled && config.timeout > 0) {
            inactivityTimer = setTimeout(lock, config.timeout * 60 * 1000);
        }

        // Atualizar timestamp de atividade para Master Reset
        config.lastActivity = Date.now();
        saveSettings();
    }

    /**
     * Verifica se o tempo para Master Reset expirou
     */
    function checkMasterReset() {
        if (config.masterReset > 0) {
            const now = Date.now();
            const msPassed = now - config.lastActivity;
            const hoursPassed = msPassed / (1000 * 60 * 60);

            if (hoursPassed >= config.masterReset) {
                performMasterReset();
            }
        }
    }

    /**
     * Executa a limpeza total do app (Master Reset)
     */
    async function performMasterReset() {
        console.warn('⚠️ Master Reset disparado por inatividade.');
        
        // Resetar timestamp para evitar loop caso dê erro
        config.lastActivity = Date.now();
        saveSettings();

        await TalkStorage.deleteAllConversations();
        
        if (window.TalkChat) {
            const msg = TalkI18n.dictionary['notif_master_reset'] || '💥 Master Reset efetuado por inatividade prolongada.';
            TalkChat.showNotification(msg, 'warning');
            setTimeout(() => location.reload(), 2000);
        } else {
            location.reload();
        }
    }

    /**
     * Bloqueia a aplicação
     */
    function lock() {
        if (isLocked) return;
        isLocked = true;
        sessionStorage.setItem(STATE_KEY, 'locked');
        showLockOverlay();
    }

    /**
     * Desbloqueia a aplicação
     */
    function unlock() {
        isLocked = false;
        sessionStorage.removeItem(STATE_KEY);
        const overlay = document.getElementById('app-lock-overlay');
        if (overlay) {
            overlay.classList.add('unlocking');
            setTimeout(() => {
                overlay.remove();
                resetInactivityTimer();
            }, 300);
        }
    }

    /**
     * Exibe a interface de bloqueio
     */
    function showLockOverlay() {
        if (document.getElementById('app-lock-overlay')) return;

        const d = TalkI18n.dictionary;
        const overlay = document.createElement('div');
        overlay.id = 'app-lock-overlay';
        overlay.innerHTML = `
            <div class="lock-card">
                <div class="lock-icon">
                    <img src="icons/icon-512.png" alt="GhostZap" style="width: 100%; height: 100%; border-radius: 18px;">
                </div>
                <h2>${d['applock_title'] || 'App Bloqueado'}</h2>
                <p>${d['applock_sub'] || 'Identifique-se para continuar sua conversa segura.'}</p>
                
                <div id="unlock-form">
                    <input type="password" id="lock-pin-input" placeholder="PIN" maxlength="6" inputmode="numeric" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other">
                    <div class="lock-actions">
                        <button id="btn-unlock-pin" class="btn-primary">${d['btn_access'] || 'Acessar'}</button>
                        ${config.useBiometrics ? `<button id="btn-unlock-bio" class="btn-secondary">${d['applock_biometrics_label'] || '🧬 Usar Digital'}</button>` : ''}
                    </div>
                </div>
                
                <div class="lock-footer">
                    <button class="btn-text" onclick="location.reload()">${d['btn_restart'] || '🔄 Reiniciar App'}</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        // Focar no input
        const input = document.getElementById('lock-pin-input');
        input.focus();

        // Eventos
        document.getElementById('btn-unlock-pin').onclick = verifyPin;
        input.onkeypress = (e) => { if (e.key === 'Enter') verifyPin(); };

        if (config.useBiometrics) {
            document.getElementById('btn-unlock-bio').onclick = verifyBiometrics;
        }
    }

    /**
     * Executa a destruição emergencial por PIN de Pânico (Wipe Silencioso)
     */
    async function performDuressWipe() {
        console.warn('🚨 DURESS PIN DISPARADO: Executando destruição completa.');
        try {
            if (window.TalkStorage) {
                await TalkStorage.deleteAllConversations();
            }
            if (window.indexedDB) {
                indexedDB.deleteDatabase('GhostZap');
            }
            localStorage.clear();
            sessionStorage.clear();
            if ('caches' in window) {
                const keys = await caches.keys();
                for (const k of keys) await caches.delete(k);
            }
        } catch (e) {
            console.error('Erro no wipe de pânico:', e);
        }
        window.location.replace('index.php?emergency_reset=' + Date.now());
    }

    /**
     * Configura o escudo de privacidade para multitarefa (evita screenshot no switcher)
     */
    function setupScreenPrivacyShield() {
        const shieldId = 'ghostzap-privacy-shield';
        
        function showShield() {
            if (!config.screenPrivacy || isLocked) return;
            if (document.getElementById(shieldId)) return;
            
            const shield = document.createElement('div');
            shield.id = shieldId;
            shield.style.cssText = 'position:fixed;inset:0;background:rgba(2,6,23,0.95);z-index:999998;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(20px);cursor:pointer;';
            shield.innerHTML = '<div style="text-align:center;pointer-events:none;"><img src="icons/icon-192.png" style="width:64px;height:64px;opacity:0.7;border-radius:18px;"><p style="color:#94a3b8;font-size:13px;margin-top:10px;font-family:sans-serif;font-weight:500;">GhostZap Protegido (Clique para desbloquear a visão)</p></div>';
            
            shield.addEventListener('click', hideShield);
            shield.addEventListener('pointerdown', hideShield);
            document.body.appendChild(shield);
        }
        
        function hideShield() {
            const shield = document.getElementById(shieldId);
            if (shield) shield.remove();
        }

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) showShield();
            else hideShield();
        });

        window.addEventListener('focus', hideShield);
        window.addEventListener('pageshow', hideShield);
        window.addEventListener('mousemove', () => {
            if (!document.hidden) hideShield();
        }, { passive: true });
        window.addEventListener('keydown', hideShield, { passive: true });
        window.addEventListener('touchstart', hideShield, { passive: true });
    }

    /**
     * Verifica o PIN digitado (suporte a PIN normal e PIN de Pânico)
     */
    async function verifyPin() {
        const input = document.getElementById('lock-pin-input');
        const pin = input.value;
        const hash = await hashPin(pin);

        // 1. Verificar PIN de Pânico / Coação
        if (config.duressPinHash && hash === config.duressPinHash) {
            await performDuressWipe();
            return;
        }

        // 2. Verificar PIN Normal
        if (hash === config.pinHash) {
            // Derivar chave de criptografia do storage se disponível
            if (typeof TalkCrypto !== 'undefined' && typeof TalkStorage !== 'undefined') {
                try {
                    const stKey = await TalkCrypto.deriveStorageKey(pin);
                    TalkStorage.setStorageKey(stKey.key);
                } catch (e) {}
            }
            unlock();
        } else {
            input.classList.add('shake');
            input.value = '';
            setTimeout(() => input.classList.remove('shake'), 500);
            const msg = TalkI18n.dictionary['error_pin_incorrect'] || '❌ PIN incorreto';
            TalkChat.showNotification(msg, 'error');
        }
    }

    /**
     * Verifica biometria (WebAuthn)
     */
    async function verifyBiometrics() {
        if (!window.PublicKeyCredential) {
            const msg = TalkI18n.dictionary['applock_biometrics_not_supported'] || 'Biometria não suportada neste navegador.';
            TalkChat.showNotification(msg, 'error');
            return;
        }

        try {
            const challenge = new Uint8Array(32);
            window.crypto.getRandomValues(challenge);

            const options = {
                publicKey: {
                    challenge: challenge,
                    timeout: 60000,
                    userVerification: 'required',
                }
            };

            await navigator.credentials.get(options);
            unlock();
        } catch (err) {
            console.warn('Falha na biometria:', err);
            if (err.name === 'NotAllowedError') {
                 TalkChat.showNotification('💡 Dica: Se o seu PIN já foi configurado mas a biometria falha, tente desativar e reativar nas configurações.', 'info');
            }
        }
    }

    /**
     * Gera hash SHA-256 do PIN
     */
    async function hashPin(pin) {
        const encoder = new TextEncoder();
        const data = encoder.encode(pin + 'ghostzap_salt');
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Abre modal de configuração de bloqueio
     */
    function openSettings() {
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-box" style="max-width: 480px; max-height: 85vh; overflow-y: auto;">
                <div class="modal-header">
                    <h3 data-i18n="applock_title">🔐 Segurança & Blindagem Anti-Forense</h3>
                    <button onclick="this.closest('.modal-overlay').remove()">✕</button>
                </div>
                <div class="modal-body" style="align-items: stretch; gap: 0;">
                    <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 20px; text-align: center;">
                        Configurações avançadas de proteção contra invasão e extração física de dados.
                    </p>

                    <div class="settings-group">
                        <label class="switch-item">
                            <span>🔒 Habilitar Bloqueio por PIN</span>
                            <input type="checkbox" id="lock-enabled" ${config.enabled ? 'checked' : ''} style="width: 20px; height: 20px; cursor: pointer;">
                        </label>
                    </div>

                    <div id="lock-options" style="${config.enabled ? '' : 'display:none'}">
                        <div class="settings-group">
                            <label>⏰ Tempo de Inatividade</label>
                            <select id="lock-timeout" class="form-select">
                                <option value="1" ${config.timeout === 1 ? 'selected' : ''}>1 minuto</option>
                                <option value="5" ${config.timeout === 5 ? 'selected' : ''}>5 minutos</option>
                                <option value="15" ${config.timeout === 15 ? 'selected' : ''}>15 minutos</option>
                                <option value="30" ${config.timeout === 30 ? 'selected' : ''}>30 minutos</option>
                            </select>
                        </div>

                        <div class="settings-group">
                            <label>🔑 Definir PIN Real de Acesso (6 dígitos)</label>
                            <input type="password" id="lock-new-pin" 
                                   placeholder="${config.pinHash ? '•••••• (Salvo - deixe em branco para manter)' : 'Digite novo PIN (6 dígitos)'}" 
                                   maxlength="6" inputmode="numeric"
                                   autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other"
                                   class="form-input">
                        </div>

                        <div class="settings-group" style="border: 1px dashed #ef4444; padding: 12px; border-radius: 10px; background: rgba(239, 68, 68, 0.05);">
                            <label style="color: #f87171; font-weight: 700;">🚨 PIN de Pânico / Coação (Wipe Silencioso)</label>
                            <input type="password" id="lock-duress-pin" 
                                   placeholder="${config.duressPinHash ? '•••••• (Configurado - deixe em branco para manter)' : 'Definir PIN de Pânico (ex: 999999)'}" 
                                   maxlength="6" inputmode="numeric"
                                   autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other"
                                   class="form-input">
                            <small style="font-size: 11px; color: #f87171; display: block; margin-top: 4px;">
                                Se digitado no desbloqueio sob coação, destrói silenciosamente todas as conversas e chaves em 1 segundo.
                            </small>
                        </div>

                        <div class="settings-group" style="margin-top: 12px;">
                            <label class="switch-item">
                                <span>🧬 Usar Biometria (Digital / Face)</span>
                                <input type="checkbox" id="lock-biometrics" ${config.useBiometrics ? 'checked' : ''} style="width: 20px; height: 20px; cursor: pointer;">
                            </label>
                        </div>
                    </div>

                    <hr style="border: 0; border-top: 1px solid var(--border); margin: 16px 0;">

                    <div class="settings-group">
                        <label class="switch-item">
                            <span style="color: var(--accent); font-weight: 600;">⚡ Modo Ghost Volátil (100% Memória RAM)</span>
                            <input type="checkbox" id="lock-volatile-mode" ${config.volatileMode ? 'checked' : ''} style="width: 20px; height: 20px; cursor: pointer;">
                        </label>
                        <small style="font-size: 11px; color: var(--text-muted); display: block; margin-top: 4px;">
                            Zero escrita no disco. As mensagens existem apenas na memória RAM e desaparecem para sempre ao fechar a aba.
                        </small>
                    </div>

                    <div class="settings-group">
                        <label class="switch-item">
                            <span>🙈 Escudo de Privacidade no Multitarefa</span>
                            <input type="checkbox" id="lock-screen-privacy" ${config.screenPrivacy !== false ? 'checked' : ''} style="width: 20px; height: 20px; cursor: pointer;">
                        </label>
                        <small style="font-size: 11px; color: var(--text-muted); display: block; margin-top: 4px;">
                            Oculta o chat com tela preta quando você troca de app no celular para evitar screenshots do sistema.
                        </small>
                    </div>

                    <div class="settings-group" style="margin-top: 15px;">
                        <label>💥 Master Reset Automático por Inatividade</label>
                        <select id="lock-master-reset" class="form-select">
                            <option value="0" ${config.masterReset === 0 ? 'selected' : ''}>Nunca apagar automaticamente</option>
                            <option value="6" ${config.masterReset === 6 ? 'selected' : ''}>Apagar tudo após 6h de inatividade</option>
                            <option value="12" ${config.masterReset === 12 ? 'selected' : ''}>Apagar tudo após 12h de inatividade</option>
                            <option value="24" ${config.masterReset === 24 ? 'selected' : ''}>Apagar tudo após 24h de inatividade</option>
                        </select>
                        <small style="font-size: 11px; color: #f87171; margin-top: 4px; display:block;">
                            Apaga todo o histórico local se você ficar sem abrir o app pelo tempo escolhido.
                        </small>
                    </div>

                    <div style="margin-top: 16px; padding: 12px; background: rgba(56, 189, 248, 0.05); border-radius: 12px; border: 1px dashed var(--accent);">
                        <h4 style="margin: 0 0 8px 0; font-size: 13px; color: var(--accent);">🔐 Backup de Emergência</h4>
                        <p style="font-size: 11px; color: var(--text-muted); margin-bottom: 10px;">
                            Frase mnemônica de 12 palavras para recuperar sua chave pública.
                        </p>
                        <button class="btn-submit" style="background: rgba(56, 189, 248, 0.1); border: 1px solid var(--accent); color: var(--accent); padding: 6px; font-size: 11px; width: 100%; cursor: pointer;" onclick="AppLock.openBackupModal()">
                            Configurar Frase de Recuperação
                        </button>
                    </div>

                    <div style="display:flex;justify-content:center;gap:16px;margin-top:14px;font-size:11px;">
                        <a href="support.html" target="_blank" rel="noopener" style="color:var(--accent,#38bdf8);text-decoration:none;">🛡️ Central de Ajuda & FAQ</a>
                        <span style="color:var(--text-secondary,#94a3b8);opacity:0.4;">•</span>
                        <a href="terms.html" target="_blank" rel="noopener" style="color:var(--text-secondary,#94a3b8);text-decoration:none;">Termos & Privacidade</a>
                    </div>
                </div>
                <div class="modal-footer" style="padding-top: 12px; border-top: none; margin-top: 10px;">
                    <button class="btn-text" onclick="this.closest('.modal-overlay').remove()">Cancelar</button>
                    <button class="btn-primary" id="save-lock-settings" style="flex: 1;">Salvar Blindagem</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        if (typeof TalkI18n !== "undefined") TalkI18n.applyTranslations();

        const checkEnabled = document.getElementById('lock-enabled');
        const optionsArea = document.getElementById('lock-options');
        
        checkEnabled.onchange = () => {
            optionsArea.style.display = checkEnabled.checked ? '' : 'none';
        };

        document.getElementById('save-lock-settings').onclick = async () => {
            const newPin = document.getElementById('lock-new-pin').value;
            const newDuressPin = document.getElementById('lock-duress-pin')?.value;
            
            if (checkEnabled.checked && !config.pinHash && !newPin) {
                alert('Por favor, defina um PIN de 6 dígitos para habilitar o bloqueio.');
                return;
            }

            config.enabled = checkEnabled.checked;
            config.timeout = parseInt(document.getElementById('lock-timeout').value);
            config.useBiometrics = document.getElementById('lock-biometrics').checked;
            config.masterReset = parseInt(document.getElementById('lock-master-reset').value);
            config.volatileMode = document.getElementById('lock-volatile-mode').checked;
            config.screenPrivacy = document.getElementById('lock-screen-privacy').checked;
            
            if (newPin) {
                config.pinHash = await hashPin(newPin);
            }
            if (newDuressPin) {
                config.duressPinHash = await hashPin(newDuressPin);
            }

            // Sincronizar modo volátil imediatamente
            if (typeof TalkStorage !== 'undefined') {
                TalkStorage.setVolatileMode(config.volatileMode);
            }

            saveSettings();
            
            if (config.enabled) {
                setupActivityListeners();
                resetInactivityTimer();
            } else {
                if (inactivityTimer) clearTimeout(inactivityTimer);
            }

            modal.remove();
            TalkChat.showNotification('✅ Configurações de blindagem salvas com sucesso!', 'success');
        };

        document.getElementById('lock-biometrics').onchange = (e) => {
            if (e.target.checked) {
                registerBiometrics();
            }
        };
    }

    /**
     * Registra biometria no dispositivo para uso posterior
     */
    async function registerBiometrics() {
        if (!window.PublicKeyCredential) {
            const msg = TalkI18n.dictionary['applock_biometrics_not_supported'] || 'Biometria não suportada neste navegador.';
            TalkChat.showNotification(msg, 'error');
            document.getElementById('lock-biometrics').checked = false;
            return;
        }

        try {
            const challenge = new Uint8Array(32);
            window.crypto.getRandomValues(challenge);
            const userId = new Uint8Array(16);
            window.crypto.getRandomValues(userId);

            const options = {
                publicKey: {
                    challenge: challenge,
                    rp: { name: "GhostZap", id: window.location.hostname || "localhost" },
                    user: {
                        id: userId,
                        name: TalkChat.state.currentUser.username,
                        displayName: TalkChat.state.currentUser.username
                    },
                    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
                    timeout: 60000,
                    authenticatorSelection: {
                        userVerification: 'required',
                        residentKey: 'required'
                    }
                }
            };
            
            await navigator.credentials.create(options);
            const msg = TalkI18n.dictionary['applock_biometrics_success'] || '✅ Biometria registrada com sucesso!';
            TalkChat.showNotification(msg, 'success');
        } catch (err) {
            console.warn('Erro ao registrar biometria:', err);
            document.getElementById('lock-biometrics').checked = false;
            if (err.name === 'NotAllowedError') {
                 const msg = TalkI18n.dictionary['applock_biometrics_canceled'] || '⚠️ Registro biométrico cancelado ou requer HTTPS.';
                 TalkChat.showNotification(msg, 'warning');
            }
        }
    }

/**
 * Modal de geração de backup
 */
function openBackupModal() {
    const phrase = TalkCrypto.generateRecoveryPhrase();
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.zIndex = '10001';
    modal.innerHTML = `
        <div class="modal-box" style="max-width: 450px;">
            <div class="modal-header">
                <h3 data-i18n="applock_phrase_title">🔐 Sua Frase de Segurança</h3>
                <button onclick="this.closest('.modal-overlay').remove()">✕</button>
            </div>
            <div class="modal-body" style="text-align: center;">
                <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 20px;" data-i18n="applock_phrase_sub">
                    Anote as 12 palavras abaixo em um local seguro. Elas são a única forma de recuperar seu histórico se você perder seu celular.
                </p>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 24px; padding: 16px; background: rgba(0,0,0,0.2); border-radius: 12px; border: 1px solid var(--border);">
                    ${phrase.split(' ').map((w, i) => `
                        <div style="background: rgba(255,255,255,0.05); padding: 8px; border-radius: 6px; font-size: 12px;">
                            <span style="opacity: 0.3; font-size: 10px;">${i + 1}</span> ${w}
                        </div>
                    `).join('')}
                </div>

                <div id="backup-status" style="margin-bottom: 20px;">
                    <button class="btn-primary" style="width: 100%;" onclick="AppLock.createBackup('${phrase}')" data-i18n="applock_backup_activate">
                        Ativar Backup e Salvar no Servidor
                    </button>
                </div>

                <p style="font-size: 11px; color: #f87171;" data-i18n="applock_backup_warning">
                    ⚠️ Nós não guardamos sua frase. Se você perdê-la, o backup no servidor será inútil.
                </p>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    if (typeof TalkI18n !== "undefined") TalkI18n.applyTranslations();
}

/**
 * Cria e envia o backup criptografado para o servidor
 */
async function createBackup(phrase) {
    const btn = document.querySelector('#backup-status button');
    btn.disabled = true;
    btn.textContent = TalkI18n.dictionary['applock_backup_encrypting'] || 'Criptografando...';

    try {
        // 1. Pegar chave privada do IndexedDB
        const keyPair = await TalkStorage.getKeyPair(TalkChat.state.currentUser.id);
        if (!keyPair) throw new Error('Chave privada não encontrada no dispositivo.');

        // 2. Criptografar com a frase
        const blob = await TalkCrypto.encryptPrivateKeyForBackup(keyPair.privateKey, phrase);

        // 3. Enviar ao servidor
        const res = await fetch('api/backup.php', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recovery_blob: blob })
        });

        if (!res.ok) throw new Error('Erro ao salvar no servidor.');

        btn.style.background = '#22c55e';
        btn.textContent = TalkI18n.dictionary['applock_backup_activated'] || '✅ Backup Ativado!';
        
        setTimeout(() => {
            printRecoveryCard(phrase);
        }, 1000);

    } catch (err) {
        console.error(err);
        btn.disabled = false;
        btn.textContent = TalkI18n.dictionary['error_backup_save'] || 'Erro ao criar backup. Tente novamente.';
    }
}

/**
 * Gera uma página de impressão elegante com a frase
 */
function printRecoveryCard(phrase) {
    const win = window.open('', '_blank');
    const d = TalkI18n.dictionary;
    win.document.write(`
        <html>
        <head>
            <title>${d['applock_recovery_card_title'] || 'Cartão de Recuperação GhostZap'}</title>
            <style>
                body { font-family: sans-serif; text-align: center; padding: 50px; color: #333; }
                .card { border: 2px solid #000; padding: 40px; border-radius: 20px; max-width: 600px; margin: 0 auto; position: relative; }
                .logo { font-size: 24px; font-weight: bold; margin-bottom: 10px; }
                .phrase-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px; margin: 30px 0; }
                .word { border: 1px solid #ccc; padding: 10px; border-radius: 8px; font-size: 16px; }
                .warning { color: red; font-size: 12px; margin-top: 20px; }
                @media print { .no-print { display: none; } }
            </style>
        </head>
        <body>
            <div class="card">
                <div class="logo">👻 ${d['applock_recovery_card_title'] || 'GhostZap Recovery Card'}</div>
                <p>${d['applock_recovery_card_sub'] || 'Guarde este cartão em um local físico seguro (ex: cofre ou gaveta).'}</p>
                <div class="phrase-grid">
                    ${phrase.split(' ').map((w, i) => `<div class="word"><b>${i + 1}.</b> ${w}</div>`).join('')}
                </div>
                <p>${d['applock_recovery_card_hint'] || 'Este código permite recuperar sua identidade e mensagens criptografadas em qualquer aparelho.'}</p>
                <div class="warning">⚠️ ${d['applock_recovery_card_warning'] || 'NUNCA compartilhe estas palavras com ninguém. Suporte do GhostZap nunca irá pedi-las.'}</div>
            </div>
            <br>
            <button class="no-print" onclick="window.print()" style="padding:10px 20px; cursor:pointer;">${d['applock_print_card'] || 'Imprimir Cartão / Salvar PDF'}</button>
        </body>
        </html>
    `);
    win.document.close();
}

return {
    init,
    lock,
    unlock,
    resetInactivityTimer,
    openSettings,
    openBackupModal,
    createBackup
};
})();
