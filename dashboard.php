<?php
// ============================================================
// dashboard.php — GhostZap Admin Dashboard v2.0
// Painel Premium com Estatísticas, Moderação e Manutenção
// ============================================================

// Inicialização segura da sessão (Compatível com PHP 7.4+)
if (session_status() === PHP_SESSION_NONE) {
    session_name('ghostzap_admin');
    session_set_cookie_params(86400, '/; SameSite=Lax', '', isset($_SERVER['HTTPS']), true);
    session_start();
}

require_once __DIR__ . '/api/lib_db.php';

$admin_pass    = "Fbr4g4@";
$isAuthenticated = !empty($_SESSION['admin_logged']);

// ── LOGIN ──
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['password'])) {
    if ($_POST['password'] === $admin_pass) {
        $_SESSION['admin_logged'] = true;
        $isAuthenticated = true;
    } else {
        $error = "Senha incorreta.";
    }
}

// ── LOGOUT ──
if (isset($_GET['logout'])) {
    session_unset(); session_destroy();
    header('Location: dashboard.php'); exit;
}

// ── AÇÕES DE ADMIN ──
$actionMsg = '';
if ($isAuthenticated && $_SERVER['REQUEST_METHOD'] === 'POST') {

    // Deletar usuário
    if (!empty($_POST['del_user'])) {
        try {
            $db = getDB();
            $uid = (int)$_POST['del_user'];
            $db->prepare("DELETE FROM users WHERE id = ?")->execute([$uid]);
            $actionMsg = "success:Usuário #{$uid} removido com sucesso.";
        } catch (Exception $e) { $actionMsg = "error:Erro ao deletar: " . $e->getMessage(); }
    }

    // Limpar relay
    if (isset($_POST['clear_relay'])) {
        try {
            $db = getDB();
            $count = $db->query("SELECT COUNT(*) FROM pending_messages")->fetchColumn();
            $db->exec("DELETE FROM pending_messages");
            $actionMsg = "success:{$count} mensagens do Relay foram limpas.";
        } catch (Exception $e) { $actionMsg = "error:Erro: " . $e->getMessage(); }
    }

    // Adicionar créditos manualmente
    if (!empty($_POST['add_credits_uid'])) {
        try {
            $db = getDB();
            $uid = (int)$_POST['add_credits_uid'];
            $amount = (float)$_POST['credit_amount'];
            $db->prepare("UPDATE users SET credits = COALESCE(credits, 0) + ? WHERE id = ?")->execute([$amount, $uid]);
            $actionMsg = "success:Adicionado R$ " . number_format($amount, 2) . " ao usuário #{$uid}.";
        } catch (Exception $e) { $actionMsg = "error:Erro ao adicionar créditos: " . $e->getMessage(); }
    }

    // Salvar configurações no .env
    if (isset($_POST['save_settings'])) {

        $toUpdate = [];
        if (isset($_POST['OPENAI_API_KEY']))   $toUpdate['OPENAI_API_KEY']   = $_POST['OPENAI_API_KEY'];
        if (isset($_POST['MP_ACCESS_TOKEN']))  $toUpdate['MP_ACCESS_TOKEN']  = $_POST['MP_ACCESS_TOKEN'];
        
        if (ghostzap_save_env($toUpdate)) {
            $actionMsg = "success:Configurações atualizadas no arquivo .env.";
            // Pequeno delay para recarregar
            header("Refresh:1; url=dashboard.php");
        } else {
            $actionMsg = "error:Erro ao salvar configurações no servidor.";
        }
    }
}

// ── DOWNLOAD DO BANCO ──
if ($isAuthenticated && isset($_GET['dl_db'])) {
    $dbFile = __DIR__ . '/database.db';
    if (file_exists($dbFile)) {
        header('Content-Description: File Transfer');
        header('Content-Type: application/octet-stream');
        header('Content-Disposition: attachment; filename="ghostzap_backup_' . date('Ymd_His') . '.db"');
        header('Content-Length: ' . filesize($dbFile));
        readfile($dbFile);
        exit;
    }
}

// ── COLETA DE DADOS ──
$stats = []; $recentUsers = []; $growthData = []; $envStatus = [];
if ($isAuthenticated) {
    try {
        $db = getDB();

        $stats['total_users']      = $db->query("SELECT COUNT(*) FROM users")->fetchColumn();
        $stats['pending_messages'] = $db->query("SELECT COUNT(*) FROM pending_messages")->fetchColumn();
        $stats['total_contacts']   = $db->query("SELECT COUNT(*) FROM contacts")->fetchColumn();
        $stats['active_24h']       = $db->query("SELECT COUNT(*) FROM users WHERE last_seen > datetime('now', '-24 hours')")->fetchColumn();
        $stats['active_1h']        = $db->query("SELECT COUNT(*) FROM users WHERE last_seen > datetime('now', '-1 hour')")->fetchColumn();
        $stats['new_users_7d']     = $db->query("SELECT COUNT(*) FROM users WHERE created_at > datetime('now', '-7 days')")->fetchColumn();
        $stats['php_version']      = PHP_VERSION;
        $dbFile                    = __DIR__ . '/database.db';
        $stats['db_size']          = @file_exists($dbFile) ? round(@filesize($dbFile) / 1024, 1) . ' KB' : 'N/A';

        // Lista de usuários (com busca)
        $search = isset($_GET['u']) ? trim($_GET['u']) : '';
        if ($search) {
            $stmt = $db->prepare("SELECT id, username, credits, created_at, last_seen FROM users WHERE username LIKE ? ORDER BY created_at DESC LIMIT 100");
            $stmt->execute(["%$search%"]);
            $recentUsers = $stmt->fetchAll();
        } else {
            $recentUsers = $db->query("SELECT id, username, credits, created_at, last_seen FROM users ORDER BY created_at DESC LIMIT 50")->fetchAll();
        }

        // Crescimento diário (últimos 7 dias)
        $growthRaw = $db->query("
            SELECT date(created_at) as day, COUNT(*) as cnt
            FROM users
            WHERE created_at >= date('now', '-6 days')
            GROUP BY date(created_at)
            ORDER BY day ASC
        ")->fetchAll();

        // Stats de Monetização e IA
        $stats['total_revenue'] = $db->query("SELECT SUM(amount) FROM payments WHERE status = 'approved'")->fetchColumn() ?: 0;
        $stats['total_ai_cost'] = $db->query("SELECT SUM(cost_usd) FROM ai_usage_logs")->fetchColumn() ?: 0;
        $stats['total_credits'] = $db->query("SELECT SUM(credits) FROM users")->fetchColumn() ?: 0;

        // Lista de pagamentos recentes
        $recentPayments = $db->query("
            SELECT p.*, u.username 
            FROM payments p 
            JOIN users u ON p.user_id = u.id 
            ORDER BY p.created_at DESC LIMIT 10
        ")->fetchAll();

        // Preenche dias vazios
        $growthMap = [];
        foreach ($growthRaw as $row) $growthMap[$row['day']] = (int)$row['cnt'];
        for ($i = 6; $i >= 0; $i--) {
            $d = date('Y-m-d', strtotime("-{$i} days"));
            $growthData[] = ['day' => date('d/m', strtotime($d)), 'cnt' => $growthMap[$d] ?? 0];
        }

        // Status do .env
        $envKeys = ['DB_PATH', 'FINGERPRINT_SALT', 'ADMIN_PASSWORD', 'APP_NAME', 'APP_ENV', 'OPENAI_API_KEY', 'MP_ACCESS_TOKEN', 'MP_PUBLIC_KEY'];
        $envFile = __DIR__ . '/.env';
        $envRaw = [];
        if (file_exists($envFile)) {
            foreach (file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                if (strpos($line, '=') !== false) {
                    [$k, $v] = explode('=', trim($line), 2);
                    $envRaw[trim($k)] = trim($v);
                }
            }
        }
        foreach ($envKeys as $k) {
            $envStatus[$k] = !empty($envRaw[$k]) ? 'ok' : 'missing';
        }

    } catch (Exception $e) {
        $stats['error'] = $e->getMessage();
    }
}

$v = @file_exists(__DIR__ . '/css/style.css') ? @filemtime(__DIR__ . '/css/style.css') : time();
?>
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GhostZap — Admin Dashboard</title>
    <link rel="stylesheet" href="css/style.css?v=<?= $v ?>">
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4/dist/chart.umd.min.js"></script>
    <style>
        *, *::before, *::after { box-sizing: border-box; }
        body {
            background: #020617;
            background-image:
                radial-gradient(at 0% 0%, rgba(56,189,248,.08) 0, transparent 50%),
                radial-gradient(at 100% 100%, rgba(168,85,247,.08) 0, transparent 50%);
            min-height: 100vh;
            overflow-y: auto;
            font-family: 'Inter', sans-serif;
            color: #f8fafc;
            padding: 40px 20px 80px;
            margin: 0;
        }

        .wrap { max-width: 1120px; margin: 0 auto; }

        /* ── HEADER ── */
        .dash-header {
            display: flex; justify-content: space-between; align-items: center;
            margin-bottom: 36px;
            padding-bottom: 24px;
            border-bottom: 1px solid rgba(255,255,255,.07);
        }
        .dash-header h1 {
            font-size: 26px; font-weight: 900;
            background: linear-gradient(135deg,#fff,#38bdf8);
            -webkit-background-clip: text; background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .dash-header p { color: #64748b; font-size: 13px; margin-top: 2px; }

        /* ── STAT CARDS ── */
        .stats-row {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 16px; margin-bottom: 24px;
        }
        .stat-card {
            background: rgba(15,23,42,.6);
            border: 1px solid rgba(255,255,255,.08);
            border-radius: 20px; padding: 22px 24px;
            transition: all .25s ease;
        }
        .stat-card:hover { border-color: rgba(56,189,248,.3); transform: translateY(-3px); }
        .stat-card h3 { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; color: #64748b; margin-bottom: 10px; }
        .stat-card .val { font-size: 36px; font-weight: 900; color: #f8fafc; }
        .stat-card .sub { font-size: 11px; color: #475569; margin-top: 4px; }

        /* ── SECTION CARD ── */
        .card {
            background: rgba(15,23,42,.6);
            border: 1px solid rgba(255,255,255,.08);
            border-radius: 24px; padding: 28px;
            margin-bottom: 24px;
        }
        .card-header {
            display: flex; justify-content: space-between; align-items: center;
            margin-bottom: 20px;
        }
        .card-header h2 { font-size: 17px; font-weight: 800; }
        .card-header span { font-size: 11px; color: #64748b; }

        /* ── TABLE ── */
        .tbl-wrap { overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; }
        th { padding: 10px 14px; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; color: #64748b; border-bottom: 1px solid rgba(255,255,255,.05); text-align: left; }
        td { padding: 14px 14px; font-size: 13px; color: #cbd5e1; border-bottom: 1px solid rgba(255,255,255,.03); }
        tr:last-child td { border-bottom: none; }
        tr:hover td { background: rgba(255,255,255,.02); }

        .ucell { display: flex; align-items: center; gap: 10px; }
        .uavatar {
            width: 30px; height: 30px; border-radius: 8px;
            background: linear-gradient(135deg,rgba(56,189,248,.25),rgba(168,85,247,.25));
            display: flex; align-items: center; justify-content: center;
            font-size: 12px; font-weight: 800; color: #7dd3fc;
            flex-shrink: 0;
        }

        .badge { padding: 3px 8px; border-radius: 6px; font-size: 10px; font-weight: 800; }
        .badge-online { background: rgba(34,197,94,.12); color: #4ade80; }
        .badge-offline { background: rgba(100,116,139,.1); color: #94a3b8; }
        .badge-warn  { background: rgba(251,191,36,.12); color: #fbbf24; }

        /* ── DELETE BTN ── */
        .btn-del {
            padding: 5px 10px; font-size: 11px; font-weight: 700;
            background: rgba(239,68,68,.1); color: #f87171;
            border: 1px solid rgba(239,68,68,.15); border-radius: 8px;
            cursor: pointer; transition: all .2s;
        }
        .btn-del:hover { background: #ef4444; color: white; }

        /* ── ACTIONS ROW ── */
        .actions-row { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 24px; }
        .btn-action {
            padding: 11px 20px;
            border-radius: 12px; font-size: 13px; font-weight: 700;
            cursor: pointer; border: none; transition: all .2s;
        }
        .btn-danger  { background: rgba(239,68,68,.1); color: #f87171; border: 1px solid rgba(239,68,68,.2); }
        .btn-danger:hover { background: #ef4444; color: white; }
        .btn-info    { background: rgba(56,189,248,.1); color: #38bdf8; border: 1px solid rgba(56,189,248,.2); }
        .btn-info:hover { background: #38bdf8; color: #000; }

        /* ── ALERT ── */
        .alert { padding: 14px 18px; border-radius: 12px; font-size: 13px; font-weight: 600; margin-bottom: 20px; }
        .alert-success { background: rgba(34,197,94,.1); color: #4ade80; border: 1px solid rgba(34,197,94,.2); }
        .alert-error   { background: rgba(239,68,68,.1); color: #f87171; border: 1px solid rgba(239,68,68,.2); }

        /* ── LOGIN ── */
        .login-wrap {
            max-width: 390px; margin: 100px auto;
            background: rgba(15,23,42,.8);
            backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
            border: 1px solid rgba(255,255,255,.1);
            border-radius: 32px; padding: 48px; text-align: center;
            box-shadow: 0 50px 100px -20px rgba(0,0,0,.5);
        }
        .login-input {
            width: 100%; padding: 15px;
            background: rgba(0,0,0,.3);
            border: 1px solid rgba(255,255,255,.1);
            border-radius: 12px; color: white;
            font-size: 16px; text-align: center;
            margin: 20px 0 14px; outline: none;
            transition: border-color .2s;
        }
        .login-input:focus { border-color: #38bdf8; box-shadow: 0 0 15px rgba(56,189,248,.15); }

        /* ── ENV STATUS ── */
        .env-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
        .env-item {
            display: flex; align-items: center; gap: 10px;
            padding: 12px 14px;
            background: rgba(0,0,0,.2); border-radius: 10px;
            border: 1px solid rgba(255,255,255,.05);
            font-size: 13px;
        }
        .env-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .env-ok   .env-dot { background: #4ade80; box-shadow: 0 0 6px #4ade80; }
        .env-miss .env-dot { background: #f87171; box-shadow: 0 0 6px #f87171; }

        /* ── SETTINGS ── */
        .form-control {
            width: 100%; padding: 10px 14px;
            background: rgba(0,0,0,.3);
            border: 1px solid rgba(255,255,255,.08);
            border-radius: 10px; color: #f8fafc;
            font-size: 13px; outline: none;
            transition: border-color .2s;
        }
        .form-control:focus { border-color: #38bdf8; }
        .form-group { margin-bottom: 16px; }
        .form-group label { display: block; font-size: 11px; font-weight: 800; color: #64748b; text-transform: uppercase; margin-bottom: 6px; }
        .btn-submit {
            background: #38bdf8; color: #020617;
            padding: 12px 24px; border-radius: 12px;
            font-size: 13px; font-weight: 800; border: none;
            cursor: pointer; transition: all .2s;
        }
        .btn-submit:hover { opacity: 0.9; transform: translateY(-1px); }

        /* ── CHART ── */
        .chart-wrap { height: 180px; }

        /* ── BTN LOGOUT ── */
        .btn-logout {
            padding: 9px 18px;
            background: rgba(239,68,68,.1); color: #f87171;
            border: 1px solid rgba(239,68,68,.2); border-radius: 11px;
            font-size: 13px; font-weight: 700; text-decoration: none; transition: all .2s;
        }
        .btn-logout:hover { background: #ef4444; color: white; }

        .footer-note { text-align: center; color: #334155; font-size: 11px; margin-top: 48px; }
    </style>
</head>
<body>

<?php if (!$isAuthenticated): ?>
<!-- ══════════════════════ LOGIN ══════════════════════ -->
<div class="login-wrap">
    <div style="width:72px;height:72px;margin:0 auto 24px;border-radius:16px;overflow:hidden;">
        <img src="icons/icon-512.png" alt="GhostZap" style="width:100%;">
    </div>
    <h1 style="font-size:22px;font-weight:900;margin-bottom:8px;">Acesso Admin</h1>
    <p style="color:#64748b;font-size:14px;">GhostZap Control Center</p>
    <form method="POST">
        <input type="password" name="password" class="login-input" placeholder="Chave Mestra" required autofocus>
        <?php if (isset($error)): ?>
            <p style="color:#f87171;font-size:13px;margin-bottom:12px;">❌ <?= $error ?></p>
        <?php endif; ?>
        <button type="submit" class="btn-primary" style="width:100%;padding:15px;border-radius:12px;font-weight:800;font-size:15px;">Entrar no Sistema</button>
    </form>
</div>

<?php else: ?>
<!-- ══════════════════════ DASHBOARD ══════════════════════ -->
<div class="wrap">

    <header class="dash-header">
        <div>
            <h1>⚡ Control Center</h1>
            <p>GhostZap — Painel Administrativo em Tempo Real</p>
        </div>
        <a href="?logout" class="btn-logout">Encerrar Sessão</a>
    </header>

    <!-- ─── CARDS DE ESTATÍSTICAS ─── -->
        <div class="stats-grid">
            <div class="stat-card">
                <div class="label">Total Usuários</div>
                <div class="value"><?= $stats['total_users'] ?></div>
                <div class="trend positive">+<?= $stats['new_users_7d'] ?> últimos 7 dias</div>
            </div>
            <div class="stat-card">
                <div class="label">Receita Total</div>
                <div class="value">R$ <?= number_format($stats['total_revenue'], 2, ',', '.') ?></div>
                <div class="trend positive">Créditos em circulação: <?= number_format($stats['total_credits'], 2) ?></div>
            </div>
            <div class="stat-card">
                <div class="label">Custo IA (API)</div>
                <div class="value">U$ <?= number_format($stats['total_ai_cost'], 4) ?></div>
                <div class="trend" style="color: #94a3b8;">Margem bruta estimada: R$ <?= number_format($stats['total_revenue'] - ($stats['total_ai_cost'] * 5), 2, ',', '.') ?></div>
            </div>
            <div class="stat-card">
                <div class="label">Ativos (24h)</div>
                <div class="value"><?= $stats['active_24h'] ?></div>
                <div class="trend" style="color: #94a3b8;"><?= $stats['active_1h'] ?> online agora</div>
            </div>
        </div>
    <!-- Alert de ação -->
    <?php if ($actionMsg): 
        [$type, $msg] = explode(':', $actionMsg, 2);
    ?>
    <div class="alert alert-<?= $type === 'success' ? 'success' : 'error' ?>">
        <?= $type === 'success' ? '✅' : '❌' ?> <?= htmlspecialchars($msg) ?>
    </div>
    <?php endif; ?>

    <!-- ── MÉTRICAS ── -->
    <div class="stats-row">
        <div class="stat-card">
            <h3>👥 Total de Usuários</h3>
            <div class="val"><?= number_format($stats['total_users'] ?? 0) ?></div>
            <div class="sub">Cadastros na rede</div>
        </div>
        <div class="stat-card">
            <h3>🟢 Online Agora (1h)</h3>
            <div class="val"><?= number_format($stats['active_1h'] ?? 0) ?></div>
            <div class="sub">Ativos na última hora</div>
        </div>
        <div class="stat-card">
            <h3>⚡ Ativos (24h)</h3>
            <div class="val"><?= number_format($stats['active_24h'] ?? 0) ?></div>
            <div class="sub">Usuários recorrentes</div>
        </div>
        <div class="stat-card">
            <h3>🌱 Novos (7d)</h3>
            <div class="val"><?= number_format($stats['new_users_7d'] ?? 0) ?></div>
            <div class="sub">Crescimento orgânico</div>
        </div>
        <div class="stat-card">
            <h3>📨 Relay Packets</h3>
            <div class="val"><?= number_format($stats['pending_messages'] ?? 0) ?></div>
            <div class="sub">Mensagens em trânsito</div>
        </div>
    </div>

    <!-- ── GRÁFICO ── -->
    <div class="card">
        <div class="card-header">
            <h2>📈 Crescimento (últimos 7 dias)</h2>
        </div>
        <div class="chart-wrap">
            <canvas id="growthChart"></canvas>
        </div>
    </div>

    <!-- ── AÇÕES DE MANUTENÇÃO ── -->
    <div class="card">
        <div class="card-header">
            <h2>🛠️ Ferramentas de Manutenção</h2>
        </div>
        <div class="actions-row">
            <form method="POST" onsubmit="return confirm('Limpar TODAS as mensagens do Relay?');">
                <button type="submit" name="clear_relay" value="1" class="btn-action btn-danger">
                    🗑️ Limpar Relay (<?= number_format($stats['pending_messages'] ?? 0) ?> msgs)
                </button>
            </form>
            <a href="?dl_db=1" class="btn-action btn-info" style="text-decoration:none;">
                💾 Baixar Backup do Banco (.db)
            </a>
        </div>
    </div>

    <!-- ── USUÁRIOS ── -->
    <div class="card">
        <div class="card-header">
            <h2>👥 Usuários Registrados</h2>
            <div style="display:flex; gap:10px;">
                <form method="GET" style="display:flex; gap:6px;">
                    <input type="text" name="u" placeholder="Buscar username..." class="form-control" style="width:200px; padding:6px 12px; height: 32px;" value="<?= htmlspecialchars($_GET['u'] ?? '') ?>">
                    <button type="submit" class="btn-info" style="padding:0 12px; border-radius:8px; height: 32px; font-size: 14px;">🔍</button>
                    <?php if(!empty($_GET['u'])): ?>
                        <a href="dashboard.php" class="btn-danger" style="padding:0 12px; border-radius:8px; text-decoration:none; display:flex; align-items:center; height: 32px; font-size: 14px;">✕</a>
                    <?php endif; ?>
                </form>
                <span style="display:flex; align-items:center;">Total: <?= number_format($stats['total_users'] ?? 0) ?></span>
            </div>
        </div>
        <div class="tbl-wrap">
            <table>
                <thead>
                    <tr>
                        <th>Usuário</th>
                        <th>Saldo</th>
                        <th>Cadastro</th>
                        <th>Última Atividade</th>
                        <th>Status</th>
                        <th>Ações</th>
                    </tr>
                </thead>
                <tbody>
                    <?php foreach ($recentUsers as $u):
                        $isOnline  = strtotime($u['last_seen']) > strtotime('-1 hour');
                        $is24h     = strtotime($u['last_seen']) > strtotime('-24 hours');
                        $firstChar = strtoupper(substr($u['username'], 0, 1));
                    ?>
                    <tr>
                        <td>
                            <div class="ucell">
                                <div class="uavatar"><?= $firstChar ?></div>
                                <strong><?= htmlspecialchars($u['username']) ?></strong>
                            </div>
                        </td>
                        <td style="font-weight:700; color:var(--accent);">R$ <?= number_format((float)($u['credits'] ?? 0), 2, ',', '.') ?></td>
                        <td><?= date('d/m/Y H:i', strtotime($u['created_at'])) ?></td>
                        <td><?= date('d/m H:i', strtotime($u['last_seen'])) ?></td>
                        <td>
                            <?php if ($isOnline): ?>
                                <span class="badge badge-online">Online</span>
                            <?php elseif ($is24h): ?>
                                <span class="badge badge-warn">Recente</span>
                            <?php else: ?>
                                <span class="badge badge-offline">Offline</span>
                            <?php endif; ?>
                        </td>
                        <td>
                            <div style="display:flex; gap:6px;">
                                <form method="POST" style="display:flex; gap:4px; align-items:center;">
                                    <input type="hidden" name="add_credits_uid" value="<?= (int)$u['id'] ?>">
                                    <input type="number" name="credit_amount" value="10" step="1" style="width:50px; padding:3px; background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.1); color:white; border-radius:4px; font-size:11px;">
                                    <button type="submit" class="btn-submit" style="padding:4px 8px; font-size:10px; border-radius:6px;">+ R$</button>
                                </form>
                                <form method="POST" onsubmit="return confirm('Deletar usuário <?= htmlspecialchars($u['username']) ?>?');">
                                    <input type="hidden" name="del_user" value="<?= (int)$u['id'] ?>">
                                    <button type="submit" class="btn-del" style="padding:4px 8px;">🗑</button>
                                </form>
                            </div>
                        </td>
                    </tr>
                    <?php endforeach; ?>
                    <?php if (empty($recentUsers)): ?>
                        <tr><td colspan="5" style="text-align:center;opacity:.4;padding:30px;">Nenhum usuário cadastrado.</td></tr>
                    <?php endif; ?>
                </tbody>
            </table>
        </div>

        <!-- ─── PAGAMENTOS RECENTES ─── -->
        <h2 style="margin-top: 40px; margin-bottom: 20px;">💰 Pagamentos Recentes (PIX)</h2>
        <div class="table-container">
            <table class="user-table">
                <thead>
                    <tr>
                        <th>ID MP</th>
                        <th>Usuário</th>
                        <th>Valor</th>
                        <th>Créditos</th>
                        <th>Status</th>
                        <th>Data</th>
                    </tr>
                </thead>
                <tbody>
                    <?php if (empty($recentPayments)): ?>
                        <tr><td colspan="6" style="text-align:center; padding: 20px; color: var(--text-muted);">Nenhum pagamento registrado.</td></tr>
                    <?php endif; ?>
                    <?php foreach ($recentPayments as $p): ?>
                        <tr>
                            <td style="font-size:11px; font-family:monospace;"><?= $p['mp_id'] ?></td>
                            <td><?= htmlspecialchars($p['username']) ?></td>
                            <td>R$ <?= number_format($p['amount'], 2, ',', '.') ?></td>
                            <td><?= number_format($p['credits_added'], 2) ?></td>
                            <td>
                                <span class="badge badge-<?= $p['status'] === 'approved' ? 'success' : 'warning' ?>">
                                    <?= strtoupper($p['status']) ?>
                                </span>
                            </td>
                            <td><?= date('d/m H:i', strtotime($p['created_at'])) ?></td>
                        </tr>
                    <?php endforeach; ?>
                </tbody>
            </table>
        </div>
    </div>

    <!-- ── CONFIGURAÇÕES ── -->
    <div class="card" id="settings">
        <div class="card-header">
            <h2>⚙️ Configurações do Sistema</h2>
            <span>Atualiza o arquivo .env automaticamente</span>
        </div>
        <form method="POST">
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 24px;">
                <div>
                    <h3 style="font-size: 12px; color: #38bdf8; margin-bottom: 15px; text-transform: uppercase;">🤖 OpenAI (IA)</h3>
                    <div class="form-group">
                        <label>OpenAI API Key</label>
                        <input type="password" name="OPENAI_API_KEY" class="form-control" placeholder="sk-..." value="<?= htmlspecialchars($envRaw['OPENAI_API_KEY'] ?? '') ?>">
                    </div>
                </div>
                <div>
                    <h3 style="font-size: 12px; color: #38bdf8; margin-bottom: 15px; text-transform: uppercase;">💳 Mercado Pago (PIX)</h3>
                    <div class="form-group">
                        <label>MP Access Token</label>
                        <input type="password" name="MP_ACCESS_TOKEN" class="form-control" placeholder="APP_USR-..." value="<?= htmlspecialchars($envRaw['MP_ACCESS_TOKEN'] ?? '') ?>">
                    </div>
                </div>
            </div>
            <div style="margin-top: 10px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,.05); display: flex; justify-content: flex-end;">
                <button type="submit" name="save_settings" class="btn-submit">Salvar Alterações</button>
            </div>
        </form>
    </div>

    <!-- ── STATUS DO .env ── -->
    <div class="card">
        <div class="card-header">
            <h2>🔑 Status do Ambiente (.env)</h2>
            <span>Banco: <?= $stats['db_size'] ?? 'N/A' ?> · PHP <?= $stats['php_version'] ?? '' ?></span>
        </div>
        <div class="env-grid">
            <?php foreach ($envStatus as $key => $st): ?>
            <div class="env-item <?= $st === 'ok' ? 'env-ok' : 'env-miss' ?>">
                <div class="env-dot"></div>
                <span><?= htmlspecialchars($key) ?></span>
                <span style="margin-left:auto;font-size:11px;color:<?= $st === 'ok' ? '#4ade80' : '#f87171' ?>">
                    <?= $st === 'ok' ? 'Configurado' : 'Ausente' ?>
                </span>
            </div>
            <?php endforeach; ?>
            <div class="env-item env-ok">
                <div class="env-dot"></div>
                <span>E2EE Blindado</span>
                <span style="margin-left:auto;font-size:11px;color:#4ade80;">Ativo 🛡️</span>
            </div>
        </div>
    </div>

    <?php if (isset($stats['error'])): ?>
    <div class="alert alert-error">⚠️ Erro de Banco: <?= htmlspecialchars($stats['error']) ?></div>
    <?php endif; ?>

    <footer class="footer-clean py-8 text-center text-gray-500/50">
        <div class="footer-link-group mb-2" style="opacity: 0.7; font-size: 0.6rem;">
            <button class="footer-a" onclick="openLegal('privacy')">Privacidade</button>
            <div class="footer-dot"></div>
            <button class="footer-a" onclick="openLegal('terms')">Termos</button>
            <div class="footer-dot"></div>
            <button class="footer-a" onclick="openLegal('help')">Ajuda</button>
        </div>
        <p class="footer-copy" style="opacity: 0.7; font-size: 0.6rem;">&copy; 2026 4U.IA.BR - Todos os direitos reservados</p>
    </footer>
</div>

<script>
// ── GRÁFICO DE CRESCIMENTO ──
const growthData = <?= json_encode($growthData) ?>;
const ctx = document.getElementById('growthChart').getContext('2d');

const gradient = ctx.createLinearGradient(0, 0, 0, 180);
gradient.addColorStop(0, 'rgba(56, 189, 248, 0.3)');
gradient.addColorStop(1, 'rgba(56, 189, 248, 0.0)');

new Chart(ctx, {
    type: 'line',
    data: {
        labels: growthData.map(d => d.day),
        datasets: [{
            label: 'Novos Usuários',
            data: growthData.map(d => d.cnt),
            borderColor: '#38bdf8',
            borderWidth: 2,
            backgroundColor: gradient,
            pointBackgroundColor: '#38bdf8',
            pointBorderColor: '#020617',
            pointBorderWidth: 2,
            pointRadius: 5,
            tension: 0.4,
            fill: true,
        }]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: 'rgba(15, 23, 42, 0.9)',
                borderColor: 'rgba(56, 189, 248, 0.3)',
                borderWidth: 1,
                titleColor: '#94a3b8',
                bodyColor: '#f8fafc',
                bodyFont: { size: 14, weight: 'bold' },
            }
        },
        scales: {
            x: {
                grid: { color: 'rgba(255,255,255,0.04)' },
                ticks: { color: '#64748b', font: { size: 11 } }
            },
            y: {
                beginAtZero: true,
                grid: { color: 'rgba(255,255,255,0.04)' },
                ticks: { color: '#64748b', stepSize: 1, font: { size: 11 } }
            }
        }
    }
});

function openLegal(type) {
    const titles = {
        privacy: 'Política de Privacidade',
        terms:   'Termos de Uso',
        help:    'Central de Ajuda'
    };
    
    const content = {
        privacy: `
            <div class="legal-modal-body" style="padding:20px; overflow-y:auto; max-height:60vh; font-size: 14px; line-height: 1.6; color: var(--text-secondary);">
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
            </div>
        `,
        terms: `
            <div class="legal-modal-body" style="padding:20px; overflow-y:auto; max-height:60vh; font-size: 14px; line-height: 1.6; color: var(--text-secondary);">
                <h4>1. Uso Responsável</h4>
                <p>Ao utilizar o GhostZap, você concorda em não utilizar a plataforma para atividades ilícitas ou que violem os direitos de terceiros.</p>
                <h4>2. Isenção de Responsabilidade</h4>
                <p>O GhostZap é uma ferramenta de comunicação privada. Não nos responsabilizamos pelo conteúdo trocado entre usuários.</p>
                <h4>3. Segurança da Conta</h4>
                <p>Você é o único responsável por manter a segurança do seu dispositivo. Se você perder o acesso ao seu navegador/IndexedDB sem backup das chaves, as mensagens não serão recuperáveis.</p>
            </div>
        `,
        help: `
            <div class="legal-modal-body" style="padding:20px; overflow-y:auto; max-height:60vh; font-size: 14px; line-height: 1.6; color: var(--text-secondary);">
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
                <button class="btn-primary" onclick="this.closest('.modal-overlay').remove()">Entendido</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}
</script>
<?php endif; ?>

</body>
</html>
