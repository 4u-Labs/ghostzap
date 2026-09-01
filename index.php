<?php
// ============================================================
// index.php — GhostZap Secure Chat
// Página de Login / Registro
// ============================================================

// Verificar se já está logado — redirecionar para o chat
session_name('ghostzap_session');
session_set_cookie_params(86400, '/; SameSite=Lax');
session_start();

// Capturar deep link ?add=username
$deepLinkAdd = '';
if (!empty($_GET['add'])) {
    $deepLinkAdd = preg_replace('/[^a-zA-Z0-9_]/', '', substr($_GET['add'], 0, 30));
}

if (!empty($_SESSION['user_id'])) {
    // Usuário já logado: redireciona mantendo o ?add= para que o chat processe
    if ($deepLinkAdd) {
        header('Location: chat.php?add=' . urlencode($deepLinkAdd));
    } else {
        header('Location: chat.php');
    }
    exit;
}

$v = filemtime(__FILE__); // anti-cache
?>
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
    <meta name="description" content="GhostZap — Chat privado com criptografia ponta-a-ponta. O servidor nunca lê suas mensagens.">
    <meta name="theme-color" content="#020617">
    
    <!-- Open Graph / Redes Sociais -->
    <meta property="og:type" content="website">
    <meta property="og:url" content="https://4u.ia.br/app/zap/">
    <link rel="canonical" href="https://4u.ia.br/app/zap/">
    <meta property="og:title" content="GhostZap — Chat Privado E2EE">
    <meta property="og:description" content="Mensagens criptografadas ponta-a-ponta onde o servidor não lê nada. Privacidade real para suas conversas.">
    <meta property="og:image" content="https://4u.ia.br/app/zap/icons/icon-512.png">
    <meta property="og:image:secure_url" content="https://4u.ia.br/app/zap/icons/icon-512.png">
    <meta property="og:image:type" content="image/png">
    <meta property="og:image:width" content="512">
    <meta property="og:image:height" content="512">
    <meta property="og:site_name" content="GhostZap">
    <meta property="og:locale" content="pt_BR">

    <!-- Schema.org (Google/Android) -->
    <meta itemprop="name" content="GhostZap — Chat Privado E2EE">
    <meta itemprop="description" content="Mensagens criptografadas ponta-a-ponta onde o servidor não lê nada. Privacy real para suas conversas.">
    <meta itemprop="image" content="https://4u.ia.br/app/zap/icons/icon-512.png">

    <!-- Twitter -->
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:url" content="https://4u.ia.br/app/zap/">
    <meta name="twitter:title" content="GhostZap — Chat Privado E2EE">
    <meta name="twitter:description" content="Mensagens criptografadas ponta-a-ponta. Zero-knowledge server.">
    <meta name="twitter:image" content="https://4u.ia.br/app/zap/icons/icon-512.png">
    
    <title>GhostZap — Chat Privado E2EE</title>
    
    <!-- Favicon -->
    <link rel="icon" type="image/png" href="icons/icon-192.png">
    
    <!-- PWA Manifest -->
    <link rel="manifest" href="manifest.json">
    
    <link rel="stylesheet" href="css/style.css?v=<?= $v ?>">
    
    <style>
        /* Estilos específicos da página de auth */
        .tab-buttons {
            display: flex;
            background: rgba(255,255,255,0.04);
            border-radius: 12px;
            padding: 4px;
            margin-bottom: 24px;
            border: 1px solid var(--border);
        }
        
        .tab-btn {
            flex: 1;
            padding: 9px;
            border: none;
            border-radius: 9px;
            background: transparent;
            color: var(--text-secondary);
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s ease;
            font-family: inherit;
        }
        
        .tab-btn.active {
            background: linear-gradient(135deg, var(--accent), var(--accent-dark));
            color: white;
            box-shadow: 0 2px 12px rgba(56, 189, 248, 0.3);
        }
        
        .form-panel { display: none; }
        .form-panel.active { display: block; animation: fadeIn 0.3s ease; }
        
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

        /* ── PWA Install Prompt ── */
        #pwa-prompt {
            position: fixed;
            bottom: 20px;
            right: 20px;
            left: 20px;
            background: var(--bg-card);
            border: 1px solid var(--accent);
            border-radius: 16px;
            padding: 16px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6);
            z-index: 10000;
            display: flex;
            align-items: center;
            gap: 12px;
            backdrop-filter: blur(12px);
            opacity: 0;
            transform: translateY(20px);
            transition: all 0.5s cubic-bezier(0.4, 0, 0.2, 1);
            pointer-events: none;
        }

        #pwa-prompt.visible {
            opacity: 1;
            transform: translateY(0);
            pointer-events: auto;
        }

        .pwa-icon { font-size: 24px; }
        .pwa-text { flex: 1; }
        .pwa-text h4 { font-size: 14px; margin: 0; color: #fff; }
        .pwa-text p { font-size: 12px; margin: 0; color: var(--text-secondary); }
        .pwa-actions { display: flex; gap: 8px; }
        .pwa-btn {
            padding: 6px 12px;
            border-radius: 8px;
            font-size: 12px;
            font-weight: 700;
            cursor: pointer;
            border: none;
        }
        .pwa-btn-install { background: var(--accent); color: #000; }
        .pwa-btn-dismiss { background: rgba(255,255,255,0.05); color: #ccc; border: 1px solid var(--border); }

        @media (min-width: 600px) {
            #pwa-prompt { width: 350px; left: auto; }
        }
    </style>
</head>
<body>
<div class="auth-page">
    <div class="auth-card">
        <!-- Seletor de Idiomas (I18n) -->
        <div class="lang-selector" style="position: absolute; top: 12px; right: 12px; z-index: 10;">
            <button class="lang-btn" data-lang="pt" onclick="TalkI18n.setLanguage('pt')" title="Português">PT</button>
            <button class="lang-btn" data-lang="en" onclick="TalkI18n.setLanguage('en')" title="English">EN</button>
            <button class="lang-btn" data-lang="es" onclick="TalkI18n.setLanguage('es')" title="Español">ES</button>
            <button class="lang-btn" data-lang="zh" onclick="TalkI18n.setLanguage('zh')" title="Mandarim">ZH</button>
        </div>

        <!-- Logo -->
        <div class="auth-logo">
            <div class="auth-logo-icon">
                <img src="icons/icon-192.png" alt="GhostZap" style="width: 100%; height: 100%; border-radius: 20%;">
            </div>
            <h1 class="auth-title">GhostZap</h1>
            <p class="auth-subtitle" data-i18n="index_subtitle">Chat privado com criptografia ponta-a-ponta</p>
        </div>
        
        <!-- Tabs: Login / Registro / Recuperar -->
        <div class="tab-buttons" role="tablist">
            <button class="tab-btn active" id="tab-login" onclick="switchTab('login')" role="tab" data-i18n="tab_login">Entrar</button>
            <button class="tab-btn" id="tab-register" onclick="switchTab('register')" role="tab" data-i18n="tab_register">Criar Conta</button>
            <button class="tab-btn" id="tab-recover" onclick="switchTab('recover')" role="tab" style="max-width:30%" data-i18n="tab_recover">Recuperar</button>
        </div>
        
        <!-- Formulário de Login -->
        <div class="form-panel active" id="panel-login">
            <form id="form-login" onsubmit="handleLogin(event)">
                <div class="form-group">
                    <label class="form-label" for="login-username" data-i18n="label_username">Usuário</label>
                    <input type="text" id="login-username" class="form-input" 
                           placeholder="seu_username" data-i18n="placeholder_username" autocomplete="username"
                           autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other"
                           required minlength="3" maxlength="30">
                </div>
                
                <div class="form-group">
                    <label class="form-label" for="login-password" data-i18n="label_password">Senha</label>
                    <input type="password" id="login-password" class="form-input" 
                           placeholder="••••••••" data-i18n="placeholder_password" autocomplete="current-password"
                           autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other"
                           required minlength="6">
                </div>
                
                <div class="form-error" id="login-error"></div>
                
                <button type="submit" class="btn-submit" id="btn-login" data-i18n="btn_login">
                    Entrar
                </button>
            </form>
        </div>
        
        <!-- Formulário de Recuperação -->
        <div class="form-panel" id="panel-recover">
            <form id="form-recover" onsubmit="handleRecovery(event)">
                <div class="form-group">
                    <label class="form-label" data-i18n="label_username">Usuário</label>
                    <input type="text" id="rec-username" class="form-input" placeholder="seu_username" data-i18n="placeholder_username"
                           autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other" required>
                </div>
                <div class="form-group">
                    <label class="form-label" data-i18n="label_password">Senha</label>
                    <input type="password" id="rec-password" class="form-input" placeholder="••••••••" data-i18n="placeholder_password"
                           autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other" required>
                </div>
                <div class="form-group">
                    <label class="form-label" data-i18n="label_recovery_phrase">Frase de Recuperação (12 palavras)</label>
                    <textarea id="rec-phrase" class="form-input" placeholder="ex: ghost safe chat private secure shadow spirit secret mask shield key code" data-i18n="placeholder_recovery_phrase" style="min-height:80px; resize:none; padding:12px; font-size:14px; line-height:1.5"
                              autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other" required></textarea>
                </div>
                <div class="form-error" id="rec-error"></div>
                <button type="submit" class="btn-submit" id="btn-recover" data-i18n="btn_recover">Recuperar Minha Conta</button>
            </form>
        </div>

        <!-- Formulário de Registro -->
        <div class="form-panel" id="panel-register">
            <form id="form-register" onsubmit="handleRegister(event)">
                <div class="form-group">
                    <label class="form-label" for="reg-username" data-i18n="label_choose_username">Escolha um username</label>
                    <input type="text" id="reg-username" class="form-input" 
                           placeholder="meu_username" data-i18n="placeholder_register_username" autocomplete="username"
                           autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other"
                           required minlength="3" maxlength="30"
                           pattern="[a-zA-Z0-9_]+"
                           title="Apenas letras, números e _">
                    <div class="form-error" id="reg-username-error"></div>
                </div>
                
                <div class="form-group">
                    <label class="form-label" for="reg-password" data-i18n="label_password">Senha</label>
                    <input type="password" id="reg-password" class="form-input" 
                           placeholder="Mínimo 6 caracteres" data-i18n="placeholder_password" autocomplete="new-password"
                           autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other"
                           required minlength="6">
                </div>
                
                <div class="form-group">
                    <label class="form-label" for="reg-password2" data-i18n="label_confirm_password">Confirmar Senha</label>
                    <input type="password" id="reg-password2" class="form-input" 
                           placeholder="Repita a senha" data-i18n="placeholder_confirm_password" autocomplete="new-password"
                           autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other"
                           required minlength="6">
                </div>
                
                <div class="form-error" id="reg-error"></div>
                
                <button type="submit" class="btn-submit" id="btn-register" data-i18n="btn_register">
                    Criar Conta
                </button>
            </form>
        </div>
        
        <!-- Aviso de Segurança -->
        <div class="security-notice">
            🔒 <strong data-i18n="security_notice_title">Privacidade total.</strong> <span data-i18n="security_notice_body">As chaves criptográficas são geradas no seu navegador 
            e <strong>NUNCA</strong> saem do seu dispositivo. Nem o servidor consegue ler suas mensagens.</span>
        </div>
    </div>

    <footer class="footer-clean py-8 text-center text-gray-500/50">
        <div class="footer-link-group mb-2" style="opacity: 0.7; font-size: 0.6rem;">
            <button class="footer-a" onclick="openLegal('privacy')" data-i18n="footer_privacy">Privacidade</button>
            <div class="footer-dot"></div>
            <button class="footer-a" onclick="openLegal('terms')" data-i18n="footer_terms">Termos</button>
            <div class="footer-dot"></div>
            <button class="footer-a" onclick="openLegal('help')" data-i18n="footer_help">Ajuda</button>
        </div>
        <p class="footer-copy" style="opacity: 0.7; font-size: 0.6rem;">&copy; 2026 4U.IA.BR - Todos os direitos reservados</p>
    </footer>
</div>

<!-- Notificações -->
<div id="notification-container"></div>

<script src="js/crypto.js?v=<?= $v ?>"></script>
<script src="js/storage.js?v=<?= $v ?>"></script>
<script src="js/i18n.js?v=<?= $v ?>"></script>
<script>
'use strict';

// Inicialização Principal (I18n + Deep Links)
(async () => {
    try {
        await TalkI18n.init();

        // ─── Processar Deep Link ?add=username ───
        const params = new URLSearchParams(window.location.search);
        const addUser = params.get('add');
        if (addUser && /^[a-zA-Z0-9_]{1,30}$/.test(addUser)) {
            localStorage.setItem('ghostzap_add_pending', addUser);
        }

        // ─── Processar Deep Link ?msg=texto ───
        const msgParam = params.get('msg');
        if (msgParam) {
            localStorage.setItem('ghostzap_msg_pending', msgParam);
        }
        
        const banner = document.createElement('div');
            banner.style.cssText = 'background:rgba(56,189,248,.1);border:1px solid rgba(56,189,248,.25);border-radius:12px;padding:12px 16px;font-size:13px;color:#7dd3fc;margin-bottom:16px;text-align:center;';
            const textKey = 'banner_add_user';
            const bannerText = (TalkI18n.dictionary[textKey] || '👋 Faça login ou crie uma conta para iniciar conversa com <strong>{user}</strong>').replace('{user}', addUser);
            banner.innerHTML = bannerText;
            const card = document.querySelector('.auth-card');
            if (card && addUser) card.insertBefore(banner, card.firstChild);
    } catch (e) {
        console.error('Error in main init:', e);
    }
})();

// ─── Funções da página de auth ───

function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.form-panel').forEach(p => p.classList.remove('active'));
    
    document.getElementById(`tab-${tab}`).classList.add('active');
    document.getElementById(`panel-${tab}`).classList.add('active');
}

function showError(elementId, message) {
    const el = document.getElementById(elementId);
    if (el) {
        el.textContent = message;
        el.classList.add('visible');
        el.previousElementSibling?.classList.add('error');
    }
}

function clearErrors() {
    document.querySelectorAll('.form-error').forEach(e => {
        e.textContent = '';
        e.classList.remove('visible');
    });
    document.querySelectorAll('.form-input').forEach(e => e.classList.remove('error'));
}

function showNotification(msg, type = 'info') {
    const container = document.getElementById('notification-container');
    const el = document.createElement('div');
    el.className = `notification notification-${type}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4000);
}

function setLoading(btnId, loading) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    
    if (loading) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>';
    } else {
        btn.disabled = false;
        // Restaurar texto original baseado na tradução
        const key = btn.getAttribute('data-i18n');
        if (key) btn.textContent = TalkI18n.dictionary[key] || btn.textContent;
    }
}

// ─── LOGIN ───

async function handleLogin(event) {
    event.preventDefault();
    clearErrors();
    
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    
    if (!username || !password) {
        showError('login-error', TalkI18n.dictionary['error_fill_fields'] || 'Preencha todos os campos.');
        return;
    }
    
    setLoading('btn-login', true);
    
    try {
        const res = await fetch('api/login.php', {
            method:      'POST',
            credentials: 'include',
            headers:     { 'Content-Type': 'application/json' },
            body:        JSON.stringify({ username, password }),
        });
        
        const data = await res.json();
        
        if (!res.ok || data.error) {
            showError('login-error', data.error || (TalkI18n.dictionary['error_login_generic'] || 'Erro ao fazer login.'));
            setLoading('btn-login', false);
            return;
        }
        
        // Login OK — redirecionar para o chat
        // O chat vai recuperar/gerar as chaves E2EE do IndexedDB
        showNotification(TalkI18n.dictionary['notif_entering'] || '✅ Entrando...', 'success');
        console.log('✅ GhostZap: Pronto!');
        
        // ─── Processar Deep Link ?msg=texto (se logado) ───
        const params = new URLSearchParams(window.location.search);
        const msgParam = params.get('msg');
        if (msgParam) {
            localStorage.setItem('ghostzap_msg_pending', msgParam);
        }
        
        window.location.href = 'chat.php';
        
    } catch (err) {
        console.error(err);
        showError('login-error', TalkI18n.dictionary['error_conn'] || 'Erro de conexão. Tente novamente.');
        setLoading('btn-login', false);
    }
}

// ─── RECUPERAÇÃO ───

async function handleRecovery(event) {
    event.preventDefault();
    clearErrors();
    
    const username = document.getElementById('rec-username').value.trim();
    const password = document.getElementById('rec-password').value;
    const phrase   = document.getElementById('rec-phrase').value.trim().toLowerCase();
    
    if (!username || !password || !phrase) {
        showError('rec-error', TalkI18n.dictionary['error_fill_fields'] || 'Preencha todos os campos.');
        return;
    }

    if (phrase.split(/\s+/).length < 12) {
        showError('rec-error', TalkI18n.dictionary['error_phrase_12'] || 'A frase deve ter 12 palavras.');
        return;
    }

    setLoading('btn-recover', true);

    try {
        // 1. Autenticar no servidor (passo normal de login)
        const loginRes = await fetch('api/login.php', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const loginData = await loginRes.json();
        
        if (!loginRes.ok || loginData.error) {
            showError('rec-error', loginData.error || (TalkI18n.dictionary['error_auth_failed'] || 'Autenticação falhou. Verifique usuário e senha.'));
            setLoading('btn-recover', false);
            return;
        }

        // 2. Buscar o blob de recuperação
        const backupRes = await fetch('api/backup.php', { credentials: 'include' });
        const backupData = await backupRes.json();

        if (!backupData.recovery_blob) {
            showError('rec-error', TalkI18n.dictionary['error_no_backup'] || 'Esta conta não possui um backup configurado no servidor.');
            setLoading('btn-recover', false);
            return;
        }

        // 3. Descriptografar a chave privada
        const privateKey = await TalkCrypto.decryptPrivateKeyFromBackup(backupData.recovery_blob, phrase);
        const publicKey  = await TalkCrypto.importPublicKey(loginData.public_key);

        // 4. Salvar as chaves no IndexedDB local
        await TalkStorage.saveKeyPair(loginData.user_id, publicKey, privateKey);

        showNotification(TalkI18n.dictionary['notif_recovery_success'] || '✅ Recuperação bem-sucedida!', 'success');
        window.location.href = 'chat.php';

    } catch (err) {
        console.error('Erro na recuperação:', err);
        showError('rec-error', err.message || 'Erro ao processar recuperação.');
        setLoading('btn-recover', false);
    }
}

// ─── REGISTRO ───

async function handleRegister(event) {
    event.preventDefault();
    clearErrors();
    
    const username  = document.getElementById('reg-username').value.trim();
    const password  = document.getElementById('reg-password').value;
    const password2 = document.getElementById('reg-password2').value;
    
    // Validações client-side
    if (!username || !password) {
        showError('reg-error', TalkI18n.dictionary['error_fill_fields'] || 'Preencha todos os campos.');
        return;
    }
    
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
        showError('reg-username-error', TalkI18n.dictionary['error_username_invalid'] || 'Use apenas letras, números e _ (3-30 caracteres).');
        return;
    }
    
    if (password.length < 6) {
        showError('reg-error', TalkI18n.dictionary['error_pass_length'] || 'Senha deve ter pelo menos 6 caracteres.');
        return;
    }
    
    if (password !== password2) {
        showError('reg-error', TalkI18n.dictionary['error_pass_mismatch'] || 'As senhas não coincidem.');
        return;
    }
    
    setLoading('btn-register', true);
    
    try {
        // 1. Gerar par de chaves E2EE no navegador
        showNotification(TalkI18n.dictionary['notif_keys_generating'] || '🔐 Gerando chaves criptográficas...', 'info');
        
        const keyPair   = await TalkCrypto.generateKeyPair();
        const publicKey = await TalkCrypto.exportPublicKey(keyPair.publicKey);
        
        // 2. Criar conta enviando apenas a chave PÚBLICA ao servidor
        // A chave privada fica APENAS no navegador (IndexedDB)
        const res = await fetch('api/register.php', {
            method:      'POST',
            credentials: 'include',
            headers:     { 'Content-Type': 'application/json' },
            body:        JSON.stringify({ username, password, public_key: publicKey }),
        });
        
        const data = await res.json();
        
        if (!res.ok || data.error) {
            showError('reg-error', data.error || (TalkI18n.dictionary['error_login_generic'] || 'Erro ao criar conta.'));
            setLoading('btn-register', false);
            return;
        }
        
        // 3. Salvar par de chaves no IndexedDB via TalkStorage
        //    (TalkStorage usa DB_VERSION=2 com todos os stores criados corretamente)
        await TalkStorage.saveKeyPair(data.user_id, keyPair.publicKey, keyPair.privateKey);
        
        showNotification(TalkI18n.dictionary['notif_account_created'] || '✅ Conta criada! Entrando...', 'success');
        setTimeout(() => { window.location.href = 'chat.php'; }, 800);

    } catch (err) {
        console.error('Registro error:', err);
        showError('reg-error', `Erro ao criar conta: ${err.message}`);
        setLoading('btn-register', false);
    }
}

// ─── MODAIS LEGAIS ───

function openLegal(type) {
    const titles = {
        privacy: TalkI18n.dictionary['legal_privacy_title'] || 'Política de Privacidade',
        terms:   TalkI18n.dictionary['legal_terms_title'] || 'Termos de Uso',
        help:    TalkI18n.dictionary['legal_help_title'] || 'Central de Ajuda'
    };
    
    const content = {
        privacy: `
            <div class="legal-modal-body">
                ${TalkI18n.dictionary['legal_privacy_body'] || `
                <h4>1. Compromisso GhostZap</h4>
                <p>O GhostZap é um sistema zero-knowledge. Isso significa que não temos acesso às suas chaves privadas nem ao conteúdo das suas mensagens.</p>
                <h4>2. Coleta de Dados</h4>
                <p>Nós coletamos apenas o seu nome de usuário e chave pública para permitir que outros usuários enviem mensagens criptografadas para você.</p>
                <h4>3. End-to-End Encryption (E2EE)</h4>
                <p>Todas as comunicações são criptografadas no seu dispositivo antes de serem enviadas ao servidor.</p>
                <h4>4. Exclusão de Mensagens</h4>
                <p>As mensagens no servidor são temporárias e funcionam apenas como um relay. Uma vez entregues, elas podem ser removidas pelo sistema.</p>
                <h4>5. Modo Incógnito (Dica de Especialista)</h4>
                <p>Para segurança máxima contra perícia forense, recomendamos o uso da <strong>Aba Anônima</strong>. Neste modo, os dados não tocam o armazenamento físico (SSD/HD) de forma permanente. Ao fechar a aba, os rastros desaparecem da memória RAM.</p>
                `}
            </div>
        `,
        terms: `
            <div class="legal-modal-body">
                ${TalkI18n.dictionary['legal_terms_body'] || `
                <h4>1. Uso Responsável</h4>
                <p>Ao utilizar o GhostZap, você concorda em não utilizar a plataforma para atividades ilícitas ou que violem os direitos de terceiros.</p>
                <h4>2. Isenção de Responsabilidade</h4>
                <p>O GhostZap é uma ferramenta de comunicação privada. Não nos responsabilizamos pelo conteúdo trocado entre usuários.</p>
                <h4>3. Segurança da Conta</h4>
                <p>Você é o único responsável por manter a segurança do seu dispositivo. Se você perder o acesso ao seu navegador/IndexedDB sem backup das chaves, as mensagens não serão recuperáveis.</p>
                `}
            </div>
        `,
        help: `
            <div class="legal-modal-body">
                ${TalkI18n.dictionary['legal_help_body'] || `
                <h4>👻 Por que as mensagens somem?</h4>
                <p>Use o ícone de relógio para definir o TTL (Tempo de Vida). Mensagens efêmeras somem para sempre de ambos os aparelhos após o tempo acabar.</p>
                
                <h4>🪄 Inteligência Artificial</h4>
                <p>Use a <strong>varinha mágica</strong> para consertar seu português ou traduzir mensagens. Além disso, transcreva seus <strong>áudios em texto</strong> instantaneamente usando o ícone de microfone.</p>
                
                <h4>📱 Como instalar manualmente?</h4>
                <p>O GhostZap é um PWA. Se você não instalou pelo aviso inicial, pode fazer assim:</p>
                <ul style="margin-left:20px; font-size:13px">
                    <li><strong>No Chrome (Android/PC):</strong> Clique nos 3 pontinhos (⋮) ou no ícone de instalar na barra de endereços.</li>
                    <li><strong>No Safari (iPhone):</strong> Clique em "Compartilhar" (↑) e depois em "Adicionar à Tela de Início".</li>
                </ul>
                `}
            </div>
        `
    };

    const linkUrl = type === 'help' ? 'support.html' : 'terms.html';
    const linkText = type === 'help' ? 'Central de Ajuda Completa ↗' : 'Termos Completos ↗';

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-box">
            <div class="modal-header">
                <h3>🛡️ ${titles[type]}</h3>
                <button onclick="this.closest('.modal-overlay').remove()">✕</button>
            </div>
            ${content[type]}
            <div class="modal-footer" style="display:flex;justify-content:space-between;align-items:center;">
                <a href="${linkUrl}" target="_blank" rel="noopener" style="color:var(--primary,#38bdf8);font-size:0.85rem;text-decoration:none;">${linkText}</a>
                <button class="btn-primary" onclick="this.closest('.modal-overlay').remove()" data-i18n="btn_understood">Entendido</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    if (typeof TalkI18n !== 'undefined') TalkI18n.applyTranslations(modal);
}

// Auto-focus no campo de username
document.getElementById('login-username').focus();

</script>

    <!-- PWA Prompt -->
    <div id="pwa-prompt">
        <div class="pwa-icon">👻</div>
        <div class="pwa-text">
            <h4 data-i18n="pwa_prompt_title">Praticidade ou Invisibilidade?</h4>
            <p data-i18n="pwa_prompt_body">Instale para maior praticidade. Use a <strong>Aba Anônima</strong> para Anti-Perícia Forense.</p>
        </div>
        <div class="pwa-actions">
            <button class="pwa-btn pwa-btn-dismiss" onclick="dismissPWA()" data-i18n="btn_no">Não</button>
            <button class="pwa-btn pwa-btn-install" onclick="installPWA()" data-i18n="btn_install">Instalar</button>
        </div>
    </div>

    <script>
        let deferredPrompt;
        const pwaPrompt = document.getElementById('pwa-prompt');

        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('sw.js');
            });
        }

        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            deferredPrompt = e;
            setTimeout(() => {
                if (!localStorage.getItem('pwa-dismissed')) {
                    pwaPrompt.classList.add('visible');
                }
            }, 2000);
        });

        function installPWA() {
            if (!deferredPrompt) return;
            pwaPrompt.classList.remove('visible');
            deferredPrompt.prompt();
            deferredPrompt.userChoice.then(() => { deferredPrompt = null; });
        }

        function dismissPWA() {
            pwaPrompt.classList.remove('visible');
            localStorage.setItem('pwa-dismissed', 'true');
        }
    </script>
</body>
</html>
