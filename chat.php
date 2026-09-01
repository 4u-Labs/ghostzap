<?php
// ============================================================
// chat.php — GhostZap Secure Chat
// Interface principal do chat (requer autenticação)
// ============================================================

session_name('ghostzap_session');
session_set_cookie_params(86400, '/; SameSite=Lax');
session_start();

// Redirecionar para login se não autenticado
if (empty($_SESSION['user_id'])) {
    header('Location: index.php');
    exit;
}

$userId   = (int)$_SESSION['user_id'];
$username = htmlspecialchars($_SESSION['username'], ENT_QUOTES, 'UTF-8');
$v = time(); // Force refresh every reload

// Buscar dados extras para o JS
$fingerprint = '...';
try {
    $dbPath = __DIR__ . '/api/lib_db.php';
    require_once $dbPath;
    $db = getDB();
    $stmt = $db->prepare('SELECT public_key FROM users WHERE id = ?');
    $stmt->execute([$userId]);
    $row = $stmt->fetch();
    if ($row) {
        $pk = $row['public_key'];
        $hash = hash('sha256', $pk . 'GhostZap_Salt_2025');
        $groups = str_split(strtoupper(substr($hash, 0, 16)), 4);
        $fingerprint = implode('-', $groups);
    }
} catch (Exception $e) { }
?>
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <meta name="description" content="GhostZap — Sua conversa privada E2EE">
    <meta name="theme-color" content="#020617">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="mobile-web-app-capable" content="yes">
    
    <title>GhostZap — Chat</title>
    
    <link rel="icon" type="image/png" href="icons/icon-192.png">
    <link rel="manifest" href="manifest.json">
    <link rel="stylesheet" href="css/style.css?v=<?= $v ?>">
    <style>
        /* PWA Sidebar Banner */
        #pwa-sidebar-banner {
            margin: 12px;
            padding: 16px;
            background: linear-gradient(135deg, rgba(56, 189, 248, 0.1), rgba(56, 189, 248, 0.05));
            border: 1px solid rgba(56, 189, 248, 0.2);
            border-radius: 12px;
            display: none; /* Hidden by default */
            flex-direction: column;
            gap: 12px;
            animation: slideIn 0.4s ease-out;
            position: relative;
            z-index: 100;
        }
        .pwa-sb-header { display: flex; align-items: center; justify-content: space-between; font-weight: 700; font-size: 13px; color: var(--accent); }
        .pwa-sb-close { cursor: pointer; opacity: 0.6; font-size: 14px; padding: 4px; transition: opacity 0.2s; }
        .pwa-sb-close:hover { opacity: 1; }
        .pwa-sb-text { font-size: 11px; color: var(--text-secondary); line-height: 1.4; }
        .pwa-sb-text strong { color: var(--accent); }
        .pwa-sb-btn { 
            width: 100%; 
            padding: 10px; 
            background: var(--accent); 
            color: #000; 
            border: none; 
            border-radius: 8px; 
            font-size: 12px; 
            font-weight: 800; 
            cursor: pointer;
            transition: all 0.2s ease;
            box-shadow: 0 4px 15px var(--accent-glow);
        }
        .pwa-sb-btn:hover { opacity: 0.9; transform: translateY(-1px); }
        @keyframes slideIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
        
        @media (max-width: 768px) {
            .sidebar-header { padding: 12px 16px !important; }
            .sidebar-top { margin-bottom: 8px !important; }
            .sidebar-actions .btn-icon { width: 34px !important; height: 34px !important; }
        }
    </style>
</head>
<body>

<div class="app-layout">
    
    <!-- ─── SIDEBAR ─── -->
    <aside id="sidebar">
        <div class="sidebar-header">
            <div class="sidebar-top">
                <div class="app-logo" id="site-logo" style="cursor:pointer">
                    <img src="icons/icon-192.png" alt="GhostZap" style="width: 32px; height: 32px; border-radius: 8px;">
                    <div>
                        <div class="app-title">GhostZap</div>
                        <div class="app-subtitle" data-i18n="app_subtitle">E2EE · Zero-Knowledge</div>
                    </div>
                </div>
                <div class="sidebar-actions">
                    <button class="btn-icon" onclick="showAddContact()" title="Adicionar contato" id="btn-add-contact" data-i18n-title="sidebar_add_contact">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/></svg>
                    </button>
                    <button class="btn-icon" onclick="TalkUI.showTutorial()" title="Tutorial e Ajuda" id="btn-tutorial" data-i18n-title="sidebar_tutorial">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/></svg>
                    </button>
                    <button class="btn-icon" onclick="TalkChat.deleteAllConversations()" title="Apagar tudo" id="btn-delete-all" data-i18n-title="sidebar_delete_all">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 9v10H8V9h8m-1.5-6h-5l-1 1H5v2h14V4h-3.5l-1-1zM18 7H6v12c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7z"/></svg>
                    </button>
                    <button class="btn-icon" onclick="AppLock.openSettings()" title="Segurança, Blindagem e Bloqueio" id="btn-lock-settings" data-i18n-title="sidebar_security">
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>
                    </button>
                </div>
            </div>

            <!-- Seletor de Idiomas (I18n) -->
            <div class="lang-selector">
                <button class="lang-btn" data-lang="pt" onclick="TalkI18n.setLanguage('pt')" title="Português">PT</button>
                <button class="lang-btn" data-lang="en" onclick="TalkI18n.setLanguage('en')" title="English">EN</button>
                <button class="lang-btn" data-lang="es" onclick="TalkI18n.setLanguage('es')" title="Español">ES</button>
                <button class="lang-btn" data-lang="zh" onclick="TalkI18n.setLanguage('zh')" title="Mandarim">ZH</button>
            </div>
        </div>
            
            <!-- PWA Sidebar Banner -->
            <div id="pwa-sidebar-banner">
                <div class="pwa-sb-header">
                    <span data-i18n="pwa_nativa">📲 Experiência Nativa</span>
                    <span class="pwa-sb-close" onclick="dismissPWA()">✕</span>
                </div>
                <div class="pwa-sb-text" data-i18n="pwa_text">
                    Instale para <strong>maior praticidade</strong> e isolamento. <br>
                    Para Anti-Perícia Forense, prefira a <strong>Aba Anônima</strong>.
                </div>
                <button class="pwa-sb-btn" onclick="installPWA()" data-i18n="pwa_btn">Instalar Agora</button>
            </div>

            <!-- Busca de usuários para adicionar -->
            <div id="add-contact-area" style="display:none">
                <div class="search-bar" style="position:relative">
                    <span class="search-icon">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                    </span>
                    <input type="text" id="user-search" class="search-input" 
                           placeholder="Buscar usuário para adicionar..."
                           data-i18n="search_users_placeholder"
                           oninput="debounceSearch(this.value)"
                           autocomplete="off"
                           autocorrect="off"
                           autocapitalize="off"
                           spellcheck="false"
                           data-form-type="other">
                    <div class="search-results" id="search-results" style="display:none"></div>
                </div>
            </div>
        
        <!-- Lista de Conversas -->
        <div id="conversation-list">
            <div class="empty-conversations">
                <div class="empty-icon">
                    <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:0.2; margin-bottom:12px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                </div>
                <p data-i18n="empty_conv_title">Nenhuma conversa ainda</p>
                <p class="sub" data-i18n="empty_conv_sub">Adicione contatos para começar</p>
            </div>
        </div>
        
        <!-- Perfil do Usuário -->
        <div class="sidebar-footer">
            <input type="file" id="avatar-input" accept="image/*" style="display:none" onchange="handleAvatarUpload(event)">

            <div class="user-profile">
                <div class="user-avatar" id="my-avatar" onclick="document.getElementById('avatar-input').click()" title="Trocar foto de perfil" style="cursor:pointer">
                    <?= strtoupper(substr($username, 0, 1)) ?>
                </div>
                <div class="user-info">
                    <div class="user-name">@<?= $username ?></div>
                    <div class="user-credits" id="unified-credits-badge" onclick="TalkUI.handleCreditsClick()" title="Créditos de IA" style="cursor:pointer; display:flex; align-items:center; gap:4px; font-size:11px; margin-top:2px; padding: 2px 8px; border-radius: 8px; background: #475569; color: white; transition: all 0.2s ease;">
                        <span style="font-size: 10px;">💎</span>
                        <span id="user-credits-val">...</span>
                    </div>
                </div>
                <div class="user-actions" style="display: flex; gap: 4px;">
                    <button class="btn-icon" onclick="showMyFingerprint()" title="Meu fingerprint de segurança" style="width: 32px; height: 32px; border-radius: 8px;" data-i18n-title="user_fingerprint">
                        <svg viewBox="0 0 24 24" fill="currentColor" style="width: 16px; height: 16px;"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
                    </button>
                    <button class="btn-icon" onclick="TalkUI.showProfileQR()" title="Meu QR Code de Contato" style="width: 32px; height: 32px; border-radius: 8px; color: #38bdf8; border-color: rgba(56,189,248,0.2);" data-i18n-title="user_qrcode">
                        <svg viewBox="0 0 24 24" fill="currentColor" style="width: 16px; height: 16px;"><path d="M3 11h8V3H3v8zm2-6h4v4H5V5zM3 21h8v-8H3v8zm2-6h4v4H5v-4zM13 3v8h8V3h-8zm6 6h-4V5h4v4zM13 13h2v2h-2zM15 15h2v2h-2zM13 17h2v2h-2zM17 13h2v2h-2zM19 15h2v2h-2zM17 17h2v2h-2zM19 19h2v2h-2zM21 17h-2v-2h2z"/></svg>
                    </button>
                    <button class="btn-icon" onclick="TalkUI.showShareModal()" title="Compartilhar GhostZap" style="width: 32px; height: 32px; border-radius: 8px;" data-i18n-title="user_share">
                        <svg viewBox="0 0 24 24" fill="currentColor" style="width: 16px; height: 16px;"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>
                    </button>
                    <button class="btn-icon" onclick="doLogout()" title="Sair da conta" style="width: 32px; height: 32px; border-radius: 8px; color: #f87171; border-color: rgba(239, 68, 68, 0.2);" data-i18n-title="user_logout">
                        <svg viewBox="0 0 24 24" fill="currentColor" style="width: 16px; height: 16px;"><path d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5c-1.11 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>
                    </button>
                </div>
            </div>
        </div>
    </aside>
    
    <!-- ─── ÁREA DO CHAT ─── -->
    <main id="chat-area-wrapper" class="hidden-mobile">
        <div id="chat-area">
            <!-- Empty state inicial -->
                <div class="empty-chat">
                    <img src="icons/icon-512.png" alt="GhostZap" style="width: 120px; height: 120px; border-radius: 20%; margin-bottom: 24px; opacity: 0.8;">
                    <h2 data-i18n="welcome_title">GhostZap</h2>
                    <p data-i18n="welcome_sub">Selecione uma conversa ou adicione um contato para começar a conversar com total privacidade.</p>
                    <div class="security-badge">
                        <span data-i18n="security_badge_e2ee">🛡️ Criptografia ponta-a-ponta (E2EE) ativa</span>
                        <span data-i18n="security_badge_zero">🚫 Servidor zero-knowledge — nunca lê suas mensagens</span>
                        <span data-i18n="security_badge_local">📱 Histórico armazenado apenas neste dispositivo</span>
                    </div>

                    <div style="margin-top:24px;">
                        <button class="btn-primary" onclick="TalkUI.showShareModal()" style="padding:12px 24px; border-radius:12px; display:inline-flex; align-items:center; gap:8px;">
                            <span data-i18n="btn_invite">📣 Convidar Amigos</span>
                        </button>
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
        </div>
    </main>
    
</div>

<!-- ─── Notificações ─── -->
<div id="notification-container"></div>

<!-- ─── Scripts ─── -->
<script src="js/crypto.js?v=<?= $v ?>"></script>
<script src="js/storage.js?v=<?= $v ?>"></script>
<script src="js/media.js?v=<?= $v ?>"></script>
<script src="js/i18n.js?v=<?= $v ?>"></script>
<script src="js/chat.js?v=<?= $v ?>"></script>
<script src="js/applock.js?v=<?= $v ?>"></script>

<script>
'use strict';

// Dados do usuário (injetados pelo PHP — sem dados sensíveis)
const CURRENT_USER = {
    id:          <?= $userId ?>,
    username:    <?= json_encode($username) ?>,
    fingerprint: <?= json_encode($fingerprint) ?>,
    credits:     0
};

// ─── Inicialização ───
document.addEventListener('DOMContentLoaded', async () => {
    try {
        console.log('🚀 GhostZap: Iniciando boot...');
        
        // 1. Tradução
        await TalkI18n.init();
        
        // 2. Chat e E2EE
        await TalkChat.init(CURRENT_USER);
        
        // 3. AppLock
        if (typeof AppLock !== 'undefined') {
            await AppLock.init();
        }
        
        console.log('✅ GhostZap: Pronto!');
        
        // ─── Processar Deep Link ?msg=texto (se logado) ───
        const params = new URLSearchParams(window.location.search);
        const msgParam = params.get('msg');
        if (msgParam) {
            localStorage.setItem('ghostzap_msg_pending', msgParam);
        }
        
    } catch (err) {
        console.error('❌ Erro Crítico de Inicialização:', err);
        if (typeof showToast === 'function') {
            showToast('Erro ao inicializar. Tente recarregar.', 'error');
        }
    }
});

// ─── Busca de Usuários ───

let searchTimer = null;

function showAddContact() {
    const area = document.getElementById('add-contact-area');
    if (!area) return;
    if (area.style.display === 'none') {
        area.style.display = 'block';
        document.getElementById('user-search')?.focus();
    } else {
        area.style.display = 'none';
        document.getElementById('search-results').style.display = 'none';
    }
}

function debounceSearch(value) {
    if (searchTimer) clearTimeout(searchTimer);
    if (!value.trim()) {
        const res = document.getElementById('search-results');
        if (res) res.style.display = 'none';
        return;
    }
    searchTimer = setTimeout(() => searchUsers(value), 400);
}

async function searchUsers(query) {
    if (!query.trim()) return;
    try {
        const res  = await fetch(`api/users.php?search=${encodeURIComponent(query)}`, { credentials: 'include' });
        const data = await res.json();
        const resultsEl = document.getElementById('search-results');
        if (!resultsEl) return;
        
        if (!data.users?.length) {
            resultsEl.innerHTML = '<div class="search-result-item" style="color:var(--text-muted)">Nenhum usuário encontrado</div>';
            resultsEl.style.display = 'block';
            return;
        }
        
        resultsEl.innerHTML = data.users.map(user => `
            <div class="search-result-item" onclick="addContact(${user.id}, '${escHtml(user.username)}', '${escHtml(user.fingerprint)}')">
                <div class="conv-avatar search-avatar" data-contact-id="${user.id}" style="width:36px;height:36px;font-size:14px">
                    ${user.username.charAt(0).toUpperCase()}
                </div>
                <div>
                    <div style="font-weight:600;font-size:14px">@${escHtml(user.username)}</div>
                    <div style="font-size:11px;color:var(--accent);font-family:monospace">🔑 ${escHtml(user.fingerprint)}</div>
                </div>
                <button style="margin-left:auto;padding:6px 12px;background:var(--accent);border:none;border-radius:8px;color:white;cursor:pointer;font-size:12px;font-weight:600">
                    Adicionar
                </button>
            </div>
        `).join('');
        
        resultsEl.querySelectorAll('.search-avatar').forEach(async el => {
            const url = await TalkChat.loadContactAvatar(el.dataset.contactId);
            if (url) TalkChat.applyAvatarToEl(el, url);
        });

        resultsEl.style.display = 'block';
    } catch (err) {
        console.error('Erro na busca:', err);
    }
}

async function addContact(contactId, username, fingerprint) {
    try {
        const res = await fetch('api/contacts.php', {
            method:      'POST',
            credentials: 'include',
            headers:     { 'Content-Type': 'application/json' },
            body:        JSON.stringify({ contact_id: contactId }),
        });
        const data = await res.json();
        if (data.success) {
            showToast(`✅ ${username} adicionado!`, 'success');
            document.getElementById('add-contact-area').style.display = 'none';
            document.getElementById('search-results').style.display = 'none';
            const searchInput = document.getElementById('user-search');
            if (searchInput) searchInput.value = '';
            await TalkUI.openContact(contactId, username, fingerprint);
            await TalkChat.loadConversations();
            document.getElementById('sidebar').classList.add('hidden-mobile');
            document.getElementById('chat-area-wrapper').classList.remove('hidden-mobile');
        }
    } catch (err) {
        showToast('❌ Erro ao adicionar contato', 'error');
    }
}

// ─── Fingerprint Modal ───

function showMyFingerprint() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-box">
            <div class="modal-header">
                <h3 data-i18n="fingerprint_title">🔑 Meu Fingerprint de Segurança</h3>
                <button onclick="this.closest('.modal-overlay').remove()">✕</button>
            </div>
            <div class="modal-body">
                <div class="fingerprint-display" style="width:100%">
                    <label data-i18n="fingerprint_label">Seu fingerprint único</label>
                    <div class="fingerprint-value">${CURRENT_USER.fingerprint || 'N/D'}</div>
                    <p class="fingerprint-hint" data-i18n="fingerprint_hint">
                        Compartilhe este código com seus contatos para que eles possam verificar 
                        que estão conversando com você.
                    </p>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn-primary" onclick="this.closest('.modal-overlay').remove()" data-i18n="btn_close">Fechar</button>
            </div>
        </div>
    `;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    document.body.appendChild(modal);
    if (typeof TalkI18n !== 'undefined') TalkI18n.applyTranslations(modal);
}

// ─── Logout ───

async function doLogout() {
    if (!confirm('Deseja sair do GhostZap?')) return;
    if (TalkChat.state.pollingTimer) clearInterval(TalkChat.state.pollingTimer);
    await fetch('api/logout.php', { credentials: 'include' });
    window.location.href = 'index.php';
}

// ─── Utilitários ───

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function showToast(message, type = 'info') {
    if (typeof TalkChat !== 'undefined' && TalkChat.showNotification) {
        TalkChat.showNotification(message, type);
    } else {
        console.log(`[Toast ${type}]: ${message}`);
    }
}

document.addEventListener('click', (e) => {
    const res = document.getElementById('search-results');
    if (res && !e.target.closest('#add-contact-area')) {
        res.style.display = 'none';
    }
});

// ─── Upload de Avatar ───

async function handleAvatarUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = '';
    const maxMB = 10;
    if (file.size > maxMB * 1024 * 1024) {
        showToast(`❌ Imagem muito grande. Máximo ${maxMB}MB.`, 'error');
        return;
    }
    showToast('🔄 Processando foto...', 'info');
    await TalkChat.uploadAvatar(file);
}

// ─── PWA Logic ───
let deferredPrompt;
const pwaBanner = document.getElementById('pwa-sidebar-banner');

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
}

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (!window.matchMedia('(display-mode: standalone)').matches) {
        if (pwaBanner) pwaBanner.style.display = 'flex';
    }
});

async function installPWA() {
    if (!deferredPrompt) return;
    if (pwaBanner) pwaBanner.style.display = 'none';
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
}

function dismissPWA() {
    if (pwaBanner) pwaBanner.style.display = 'none';
    localStorage.setItem('pwa-dismissed', 'true');
}

// ─── COMPARTILHAMENTO E LEGAIS ───

function shareApp(platform) {
    const url = 'https://4u.ia.br/app/zap';
    const text = 'Ei, vamos conversar no GhostZap? É um chat privado com criptografia ponta-a-ponta. 🔐🚀';
    let shareUrl = '';
    if (platform === 'whatsapp') shareUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(text + ' ' + url)}`;
    else if (platform === 'facebook') shareUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
    else if (platform === 'twitter') shareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
    if (shareUrl) window.open(shareUrl, '_blank');
}

function openLegal(type) {
    const titles = {
        privacy: (typeof TalkI18n !== 'undefined' ? TalkI18n.t('legal_privacy_title') : '') || 'Política de Privacidade',
        terms:   (typeof TalkI18n !== 'undefined' ? TalkI18n.t('legal_terms_title') : '') || 'Termos de Uso',
        help:    (typeof TalkI18n !== 'undefined' ? TalkI18n.t('legal_help_title') : '') || 'Central de Ajuda'
    };
    
    const content = {
        privacy: `
            <div class="legal-modal-body" style="padding:20px; overflow-y:auto; max-height:60vh; font-size: 14px; line-height: 1.6; color: var(--text-secondary);">
                ${(typeof TalkI18n !== 'undefined' ? TalkI18n.t('legal_privacy_body') : '') || `
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
            <div class="legal-modal-body" style="padding:20px; overflow-y:auto; max-height:60vh; font-size: 14px; line-height: 1.6; color: var(--text-secondary);">
                ${(typeof TalkI18n !== 'undefined' ? TalkI18n.t('legal_terms_body') : '') || `
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
            <div class="legal-modal-body" style="padding:20px; overflow-y:auto; max-height:60vh; font-size: 14px; line-height: 1.6; color: var(--text-secondary);">
                ${(typeof TalkI18n !== 'undefined' ? TalkI18n.t('legal_help_body') : '') || `
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

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-box">
            <div class="modal-header">
                <h3>🛡️ ${titles[type]}</h3>
                <button onclick="this.closest('.modal-overlay').remove()">✕</button>
            </div>
            ${content[type]}
            <div class="modal-footer">
                <button class="btn-primary" onclick="this.closest('.modal-overlay').remove()">${(typeof TalkI18n !== 'undefined' ? TalkI18n.t('btn_understood') : '') || 'Entendido'}</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    if (typeof TalkI18n !== 'undefined') TalkI18n.applyTranslations(modal);
}
</script>

</body>
</html>
