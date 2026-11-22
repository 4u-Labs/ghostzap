<?php

// Optional Mercado Pago x-signature HMAC-SHA256 verification when MP_WEBHOOK_SECRET is set
if (defined('MP_WEBHOOK_SECRET') && MP_WEBHOOK_SECRET !== '') {
    $_rawBody = $rawBody ?? ($input ?? (file_get_contents('php://input') ?: ''));
    $_b = json_decode((string) $_rawBody, true) ?? [];
    $_mpPid = (string) ($_b['data']['id'] ?? ($_GET['data_id'] ?? ($_GET['id'] ?? '')));
    $_xSig  = (string) ($_SERVER['HTTP_X_SIGNATURE'] ?? '');
    $_xReq  = (string) ($_SERVER['HTTP_X_REQUEST_ID'] ?? '');
    $_ts = ''; $_v1 = '';
    foreach (explode(',', $_xSig) as $_part) {
        $_kv = explode('=', trim($_part), 2);
        if (count($_kv) === 2) { if ($_kv[0] === 'ts') $_ts = $_kv[1]; if ($_kv[0] === 'v1') $_v1 = $_kv[1]; }
    }
    $_exp = hash_hmac('sha256', "id:{$_mpPid};request-id:{$_xReq};ts:{$_ts};", MP_WEBHOOK_SECRET);
    if ($_mpPid !== '' && ($_v1 === '' || !hash_equals($_exp, $_v1))) { http_response_code(401); exit('Invalid signature'); }
}
// ============================================================
// api_mp_webhook.php — GhostZap Secure Chat
// Webhook para receber notificações do Mercado Pago
// ============================================================

require_once 'lib_db.php';

// Mercado Pago envia via query string o type e o id (ex: data.id)
$type = $_GET['type'] ?? '';
$mpId = $_GET['data_id'] ?? ($_GET['id'] ?? '');

if ($type === 'payment' && $mpId) {
    $accessToken = ghostzap_env('MP_ACCESS_TOKEN');
    
    if (!$accessToken) exit;

    // Consultar status no MP
    $ch = curl_init("https://api.mercadopago.com/v1/payments/$mpId");
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, ["Authorization: Bearer $accessToken"]);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
    $response = curl_exec($ch);
    curl_close($ch);

    $data = json_decode($response, true);

    if (isset($data['status']) && $data['status'] === 'approved') {
        try {
            $db = getDB();
            
            // Verifica se já não foi processado
            $stmt = $db->prepare("SELECT status, user_id, credits_added FROM payments WHERE mp_id = ?");
            $stmt->execute([(string)$mpId]);
            $payment = $stmt->fetch();

            if ($payment && $payment['status'] === 'pending') {
                $db->beginTransaction();
                
                // 1. Atualiza status do pagamento
                $stmtU = $db->prepare("UPDATE payments SET status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE mp_id = ?");
                $stmtU->execute([(string)$mpId]);

                // 2. Adiciona créditos ao usuário
                $stmtS = $db->prepare("UPDATE users SET credits = COALESCE(credits, 0) + ? WHERE id = ?");
                $stmtS->execute([(float)$payment['credits_added'], (int)$payment['user_id']]);

                $db->commit();
            }
        } catch (Exception $e) {
            if ($db->inTransaction()) $db->rollBack();
        }
    }
}

// Retornar 200 para o MP não re-enviar
http_response_code(200);
echo "OK";
