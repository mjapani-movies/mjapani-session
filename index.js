<!DOCTYPE html>
<html lang="sw">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MJAPANI SESSION · LIVE</title>
<style>
  :root{
    --bg:#050505;
    --card:#121212;
    --card-border:#2a1010;
    --accent:#e11d2e;
    --accent2:#ff3b3b;
    --accent-glow:rgba(225,29,46,0.45);
    --orange:#ff6b1a;
    --text:#f5f5f5;
    --muted:#a0a0a0;
    --ok:#22c55e;
    --err:#ef4444;
  }
  *{box-sizing:border-box; margin:0; padding:0}
  body{
    min-height:100vh;
    background:
      radial-gradient(ellipse 80% 50% at 50% -20%, rgba(225,29,46,0.18), transparent),
      radial-gradient(circle at 80% 80%, rgba(255,107,26,0.08), transparent),
      var(--bg);
    color:var(--text);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    display:flex; align-items:flex-start; justify-content:center;
    padding:28px 16px 40px;
  }
  .wrap{max-width:440px; width:100%}

  /* LOGO SECTION */
  .logo-wrap{
    text-align:center;
    margin-bottom:22px;
    position:relative;
  }
  .logo-img{
    width:200px;
    height:200px;
    object-fit:contain;
    border-radius:28px;
    box-shadow:
      0 0 0 2px rgba(255,60,40,0.35),
      0 12px 40px rgba(225,29,46,0.35),
      0 0 60px rgba(225,29,46,0.15);
    transition: transform .3s ease, box-shadow .3s ease;
  }
  .logo-img:hover{
    transform: scale(1.03);
    box-shadow:
      0 0 0 3px rgba(255,80,50,0.5),
      0 16px 50px rgba(225,29,46,0.45),
      0 0 80px rgba(225,29,46,0.25);
  }
  .live-badge{
    display:inline-flex;
    align-items:center;
    gap:6px;
    background:linear-gradient(135deg, #e11d2e, #c4111f);
    color:#fff;
    font-size:11px;
    font-weight:800;
    letter-spacing:1.5px;
    padding:5px 12px;
    border-radius:20px;
    margin-top:14px;
    box-shadow:0 4px 15px rgba(225,29,46,0.4);
  }
  .live-dot{
    width:7px; height:7px;
    background:#fff;
    border-radius:50%;
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse{
    0%,100%{ opacity:1; transform:scale(1); }
    50%{ opacity:0.4; transform:scale(0.75); }
  }
  .logo-title{
    margin-top:12px;
    font-size:22px;
    font-weight:800;
    letter-spacing:1px;
  }
  .logo-title span{ color:var(--accent); }
  .logo-sub{
    color:var(--muted);
    font-size:13px;
    margin-top:4px;
  }

  /* CARD */
  .card{
    background:var(--card);
    border:1px solid var(--card-border);
    border-radius:20px;
    padding:24px;
    box-shadow:
      0 20px 50px rgba(0,0,0,0.5),
      inset 0 1px 0 rgba(255,255,255,0.04);
    position:relative;
    overflow:hidden;
  }
  .card::before{
    content:"";
    position:absolute; top:0; left:0; right:0; height:2px;
    background:linear-gradient(90deg, transparent, var(--accent), var(--orange), var(--accent), transparent);
  }

  /* TABS */
  .tabs{
    display:flex; gap:6px; margin-bottom:20px;
    background:#0a0a0a; padding:5px; border-radius:14px;
    border:1px solid #1f1f1f;
  }
  .tab{
    flex:1; text-align:center; padding:11px 8px; border-radius:10px;
    cursor:pointer; color:var(--muted); font-weight:700; font-size:13.5px;
    transition: all .2s ease;
  }
  .tab:hover{ color:#ddd; }
  .tab.active{
    background:linear-gradient(135deg, var(--accent), #b91c1c);
    color:#fff;
    box-shadow:0 4px 14px rgba(225,29,46,0.35);
  }

  .panel{display:none}
  .panel.active{display:block}

  input[type=text]{
    width:100%; padding:13px 15px; border-radius:12px;
    border:1px solid #2a2a2a; background:#0a0a0a; color:var(--text);
    font-size:15px; outline:none; transition:border .2s, box-shadow .2s;
  }
  input[type=text]:focus{
    border-color:var(--accent);
    box-shadow:0 0 0 3px rgba(225,29,46,0.2);
  }
  label{font-size:12.5px; color:var(--muted); display:block; margin-bottom:7px; font-weight:500}

  button.primary{
    width:100%; margin-top:16px; padding:14px; border:none; border-radius:12px;
    background:linear-gradient(135deg, var(--accent), #c4111f);
    color:#fff; font-size:15px; font-weight:700; cursor:pointer;
    transition: transform .15s, box-shadow .15s, opacity .15s;
    box-shadow:0 6px 20px rgba(225,29,46,0.35);
  }
  button.primary:hover:not(:disabled){
    transform:translateY(-1px);
    box-shadow:0 8px 25px rgba(225,29,46,0.45);
  }
  button.primary:active:not(:disabled){ transform:translateY(0); }
  button.primary:disabled{ opacity:.45; cursor:not-allowed; box-shadow:none; }

  .qr-box{text-align:center; margin-top:18px}
  .qr-box img{
    width:230px; height:230px; border-radius:16px;
    background:#fff; padding:10px;
    box-shadow:0 8px 30px rgba(0,0,0,0.4);
  }
  .code-box{
    text-align:center; margin-top:18px; font-size:32px; letter-spacing:8px;
    font-weight:800; background:#0a0a0a;
    border:1.5px dashed var(--accent); border-radius:14px; padding:20px;
    color:#fff; text-shadow:0 0 20px rgba(225,29,46,0.4);
  }
  .status{
    text-align:center; color:var(--muted); font-size:13.5px;
    margin-top:14px; min-height:20px; font-weight:500;
  }
  .status.err{color:var(--err)}
  .status.ok{color:var(--ok)}

  .session-box{margin-top:18px}
  textarea{
    width:100%; min-height:115px; background:#0a0a0a; color:var(--ok);
    border:1px solid #1a3a1a; border-radius:12px; padding:13px;
    font-size:12px; word-break:break-all; resize:vertical; line-height:1.45;
  }
  .copy-btn{
    width:100%; margin-top:12px; padding:13px; border-radius:12px;
    border:1.5px solid var(--ok); background:transparent; color:var(--ok);
    font-weight:700; cursor:pointer; font-size:14px;
    transition: background .2s, color .2s;
  }
  .copy-btn:hover{ background:rgba(34,197,94,0.12); }

  .warn{
    font-size:12.5px; color:var(--muted); margin-top:12px;
    line-height:1.55; background:rgba(255,255,255,0.03);
    padding:10px 12px; border-radius:10px; border-left:3px solid #333;
  }
  .hidden{display:none}

  .spinner{
    width:15px; height:15px; border:2px solid rgba(255,255,255,.25);
    border-top-color:#fff; border-radius:50%;
    display:inline-block; animation:spin .75s linear infinite;
    vertical-align:-2px; margin-right:7px;
  }
  @keyframes spin{to{transform:rotate(360deg)}}

  footer{
    text-align:center; color:#666; font-size:11.5px; margin-top:22px;
    letter-spacing:0.3px;
  }
  footer b{ color:#999; }
</style>
</head>
<body>
<div class="wrap">
  <div class="logo-wrap">
    <img class="logo-img" src="data:image/jpeg;base64,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
