<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, private');
header('X-Content-Type-Options: nosniff');
ini_set('display_errors','0');
require_once __DIR__.'/server/service.php';
try {
    if ($_SERVER['REQUEST_METHOD']!=='POST') { http_response_code(405); header('Allow: POST'); echo json_encode(['error'=>'Use a JSON POST request.']); exit; }
    $contentType=$_SERVER['CONTENT_TYPE']??'';
    tk_require(stripos($contentType,'application/json')===0,'Send this request as JSON.');
    $raw=file_get_contents('php://input',false,null,0,16385);
    tk_require($raw!==false && strlen($raw)<=16384,'This request is too large.');
    $request=json_decode($raw,true,32,JSON_THROW_ON_ERROR);
    tk_require(is_array($request),'Send a JSON object.');
    echo json_encode(tk_dispatch(tk_database(),$request),JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE);
} catch (PDOException $e) {
    error_log('Troika database error: '.$e->getMessage()); http_response_code(503);
    echo json_encode(['error'=>'Game storage is unavailable. Check PHP SQLite and temporary-folder permissions, then retry.']);
} catch (JsonException $e) {
    http_response_code(400); echo json_encode(['error'=>'Send valid JSON.']);
} catch (RuntimeException $e) {
    http_response_code(400); echo json_encode(['error'=>$e->getMessage()],JSON_UNESCAPED_UNICODE);
} catch (Throwable $e) {
    error_log('Troika internal error: '.$e->getMessage()); http_response_code(500);
    echo json_encode(['error'=>'The game could not process that action. Try again.']);
}
