// app.js — frontend for Spin the Wheel 24/7 (paid plays + credits + referrals).
// Polls /api/state, draws the neon wheel, animates the spin when a round
// closes, and handles buying, claiming, guessing, and referrals.
(function () {
  'use strict';

  var SEGMENTS = 101;
  var SEG = (Math.PI * 2) / SEGMENTS;
  var COLORS = ['#22d3ee', '#8b5cf6', '#ec4899', '#3b82f6', '#14b8a6', '#f59e0b', '#6366f1', '#d946ef'];
  var TAU = Math.PI * 2;

  var canvas = document.getElementById('wheel');
  var ctx = canvas.getContext('2d');
  var W = canvas.width; // 1200 backing resolution
  var CX = W / 2, CY = W / 2, R = W / 2 - 8;

  var rot = 0;
  var spinning = false;
  var spinStart = 0, spinFrom = 0, spinTo = 0;
  var holdUntil = 0;
  var lastRoundId = null;
  var lastState = null;

  // ---- player identity (no login: a token on this device) ----------------
  function newToken() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var s = '';
    var hex = '0123456789abcdef';
    for (var i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)];
    return s;
  }
  var playerToken = localStorage.getItem('stw247_token') || '';
  if (!playerToken) { playerToken = newToken(); localStorage.setItem('stw247_token', playerToken); }
  var myName = (localStorage.getItem('stw247_name') || '').trim();

  var params = new URLSearchParams(window.location.search);
  var refParam = (params.get('ref') || '').trim().toUpperCase();
  var paidParam = (params.get('paid') || '').trim().toLowerCase();
  var orderParam = (params.get('orderId') || params.get('order_id') || '').trim();

  // ---- wheel --------------------------------------------------------------
  function mod(n, m) { return ((n % m) + m) % m; }
  function pointerIndex(r) { return Math.floor(mod(-Math.PI / 2 - r, TAU) / SEG); }
  function rotationForTarget(target) { return -Math.PI / 2 - (target * SEG + SEG / 2); }

  function drawWheel() {
    ctx.clearRect(0, 0, W, W);
    for (var i = 0; i < SEGMENTS; i++) {
      var a0 = rot + i * SEG;
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.arc(CX, CY, R, a0, a0 + SEG);
      ctx.closePath();
      ctx.fillStyle = COLORS[i % COLORS.length];
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(CX, CY, R - 32, 0, TAU);
    ctx.strokeStyle = 'rgba(2,6,18,.42)';
    ctx.lineWidth = 52;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 26px Rajdhani, sans-serif';
    for (var n = 0; n < SEGMENTS; n++) {
      var a = rot + n * SEG + SEG / 2;
      var x = CX + Math.cos(a) * (R - 58);
      var y = CY + Math.sin(a) * (R - 58);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a + Math.PI / 2);
      ctx.lineWidth = 7;
      ctx.strokeStyle = 'rgba(2,6,18,.9)';
      ctx.strokeText(String(n), 0, 0);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(n), 0, 0);
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(CX, CY, R, 0, TAU);
    ctx.strokeStyle = 'rgba(34,211,238,.9)';
    ctx.lineWidth = 6;
    ctx.shadowColor = '#22d3ee';
    ctx.shadowBlur = 24;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(CX, CY, 74, 0, TAU);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(CX - 26, 6);
    ctx.lineTo(CX + 26, 6);
    ctx.lineTo(CX, 64);
    ctx.closePath();
    ctx.fillStyle = '#f59e0b';
    ctx.shadowColor = '#f59e0b';
    ctx.shadowBlur = 18;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  function updateReadout() {
    var idx = pointerIndex(rot);
    document.getElementById('currentNum').textContent = idx;
    document.getElementById('prevNum').textContent = mod(idx - 1, SEGMENTS);
    document.getElementById('nextNum').textContent = mod(idx + 1, SEGMENTS);
  }

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function startSpinAnimation(winningNumber) {
    var target = rotationForTarget(winningNumber);
    var delta = mod(target - rot, TAU);
    spinFrom = rot;
    spinTo = rot + 5 * TAU + delta;
    spinStart = performance.now();
    spinning = true;
  }

  function frame(now) {
    if (spinning) {
      var t = Math.min(1, (now - spinStart) / 4500);
      rot = spinFrom + (spinTo - spinFrom) * easeOutCubic(t);
      if (t >= 1) { spinning = false; rot = spinTo; holdUntil = now + 25000; }
    } else if (now > holdUntil) {
      rot += 0.00035;
    }
    drawWheel();
    updateReadout();
    requestAnimationFrame(frame);
  }

  // ---- helpers --------------------------------------------------------------
  function money(cents) { return '$' + (cents / 100).toFixed(2); }
  function fmtCountdown(ms) {
    if (ms <= 0) return 'SPINNING…';
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function fmtTime(ms) {
    return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(id) { return document.getElementById(id); }

  // ---- render ---------------------------------------------------------------
  function render(state) {
    lastState = state;
    $('jackpot').textContent = money(state.jackpotCents);
    $('roundLabel').textContent =
      'Round #' + state.round.id + ' • spins ' + fmtTime(state.round.ends_at) + ' ET';
    $('pot').textContent = money(state.round.potCents);
    $('potSub').textContent = state.round.paidPlays + ' paid plays • winner ' +
      money(state.round.winnerShareCents) + ' • jackpot +' + money(state.round.jackpotShareCents);

    // Payments banner + buy buttons
    var banner = $('payBanner');
    var buyBox = $('buyBox');
    if (state.payments.mode === 'free') {
      banner.style.display = '';
      banner.innerHTML = '<b>FREE PREVIEW</b> — payments are being connected. Plays are free right now and add $0 to the pot. Paid play ($5) and the $100 bundle start soon.';
      buyBox.style.display = 'none';
      $('claimBox').style.display = 'none';
    } else {
      banner.style.display = 'none';
      buyBox.style.display = '';
      var singleBtn = $('buySingleBtn');
      var bundleBtn = $('buyBundleBtn');
      if (state.payments.enabled) {
        singleBtn.href = state.payments.singlePlayUrl;
        bundleBtn.href = state.payments.bundleUrl;
        singleBtn.classList.remove('disabled');
        bundleBtn.classList.remove('disabled');
        $('buyNote').textContent = 'Pay securely with Square — you\'ll come right back here to claim your plays.';
      } else {
        singleBtn.href = '#';
        bundleBtn.href = '#';
        singleBtn.classList.add('disabled');
        bundleBtn.classList.add('disabled');
        $('buyNote').textContent = 'Payment links are being set up — check back shortly.';
      }
    }

    // Credits
    if (state.me) {
      $('paidCredits').textContent = state.me.paidCredits;
      $('bonusCredits').textContent = state.me.bonusCredits;
      var link = window.location.origin + window.location.pathname + '?ref=' + state.me.referralCode;
      $('refLink').value = link;
      $('refStats').textContent = 'Free plays earned: ' + state.me.referralCreditsEarned +
        ' • Friends who paid: ' + state.me.friendsPaid;
    }

    // Round changed → the previous round just spun.
    if (lastRoundId !== null && state.round.id !== lastRoundId && state.lastResult) {
      startSpinAnimation(state.lastResult.winning_number);
    }
    if (lastRoundId === null && state.lastResult) {
      rot = rotationForTarget(state.lastResult.winning_number);
      holdUntil = performance.now() + 25000;
    }
    lastRoundId = state.round.id;

    var bannerEl = $('resultBanner');
    if (state.lastResult) {
      var r = state.lastResult;
      bannerEl.style.display = '';
      bannerEl.classList.toggle('jackpot-hit', r.winner_exact);
      bannerEl.innerHTML = r.winner_exact
        ? 'JACKPOT HIT! <span class="big">' + r.winning_number + '</span> — ' + esc(r.winner_names || '') +
          ' takes <b>' + money(r.winner_payout_cents || 0) + '</b> (round win + jackpot)'
        : 'Last spin: <span class="big">' + r.winning_number + '</span>' +
          (r.winner_names
            ? ' — closest was <b>' + esc(r.winner_names) + '</b> (' + r.winner_guess + '), wins <b>' + money(r.winner_payout_cents || 0) + '</b>'
            : ' — no guesses that round, jackpot rolled over');
    } else {
      bannerEl.style.display = 'none';
    }

    // Guesses
    var chips = $('guessChips');
    var mine = state.round.guesses.filter(function (g) { return g.mine; });
    $('noGuesses').style.display = state.round.guesses.length ? 'none' : '';
    chips.innerHTML = state.round.guesses.map(function (g) {
      var tag = g.credit_type === 'paid' ? '<span class="tag-paid">$5</span>' : '<span class="tag-free">FREE</span>';
      return '<span class="chip' + (g.mine ? ' mine' : '') + '">' + esc(g.name) + ' <b>' + g.guess + '</b> ' + tag + '</span>';
    }).join('');

    var youIn = $('youIn');
    if (mine.length) {
      youIn.style.display = '';
      youIn.textContent = 'You’re in this round: ' + mine.map(function (g) { return g.guess; }).join(', ') +
        '. Each guess cost 1 credit. Want another number? It costs 1 more credit.';
    } else {
      youIn.style.display = 'none';
    }

    // Leaderboard
    var lb = $('leaderboard');
    if (!state.leaderboard.length) {
      lb.innerHTML = '<p class="empty-note">No winners yet — the first round will crown someone soon.</p>';
    } else {
      lb.innerHTML = '<table><tr><th>#</th><th>Player</th><th class="num">Won</th><th class="num">Rounds</th><th class="num">Jackpots</th></tr>' +
        state.leaderboard.map(function (p, i) {
          var isMe = state.me && p.name.toLowerCase() === (state.me.name || '').toLowerCase();
          return '<tr' + (isMe ? ' class="me"' : '') + '><td>' + (i + 1) + '</td><td>' + esc(p.name) + '</td>' +
            '<td class="num">' + money(p.won_cents) + '</td><td class="num">' + p.rounds_won + '</td><td class="num">' + p.jackpots_won + '</td></tr>';
        }).join('') + '</table>';
    }

    // History
    var hist = $('history');
    $('noHistory').style.display = state.history.length ? 'none' : '';
    hist.innerHTML = state.history.map(function (h) {
      return '<li><span>Round #' + h.round_id + ' • ' + fmtTime(h.ended_at) + ' ET</span>' +
        '<span>winning <span class="wn">' + h.winning_number + '</span>' +
        (h.winner_names ? ' — ' + esc(h.winner_names) + ' won <b>' + money(h.winner_payout_cents || 0) + '</b>' +
          (h.winner_exact ? ' <span class="jp">JACKPOT ' + money(h.jackpot_paid_cents || 0) + '</span>' : '') : ' — no guesses') +
        ' • pot ' + money(h.pot_cents || 0) +
        '</span></li>';
    }).join('');

    // Sponsors
    $('sponsors').innerHTML = state.sponsors.map(function (s) {
      if (s.name) {
        return '<div class="sponsor filled"><div class="s-name">' + esc(s.name) + '</div>' +
          '<div class="s-msg">' + esc(s.message) + '</div>' +
          '<div class="s-price">$' + s.price + ' / spot</div></div>';
      }
      return '<div class="sponsor"><div class="s-avail">Spot ' + s.slot + ' available</div>' +
        '<div class="s-msg">Your business here, every round.</div>' +
        '<div class="s-price">$25–$50 / spot</div></div>';
    }).join('');
  }

  function poll() {
    fetch('/api/state?playerToken=' + encodeURIComponent(playerToken))
      .then(function (res) { return res.json(); })
      .then(render)
      .catch(function () { /* keep the last good state on screen */ });
  }

  setInterval(function () {
    if (!lastState) return;
    $('countdown').textContent = fmtCountdown(lastState.round.ends_at - Date.now());
  }, 1000);

  // ---- player registration (captures ?ref= on first visit) ----------------
  function registerPlayer() {
    return fetch('/api/player', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerToken: playerToken, name: myName || undefined, ref: refParam || undefined }),
    }).then(function (res) { return res.json(); }).catch(function () { return null; });
  }

  // ---- claim flow -----------------------------------------------------------
  var claimBox = $('claimBox');
  function showClaim(kind) {
    claimBox.style.display = '';
    $('claimText').textContent = kind === 'bundle'
      ? 'Paid $100 on Square? Claim your 22 plays (20 paid + 2 free).'
      : 'Paid $5 on Square? Claim your 1 play.';
    claimBox.dataset.kind = kind;
    if (orderParam) $('claimOrderId').value = orderParam;
    claimBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  if (paidParam === 'single' || paidParam === 'bundle') {
    showClaim(paidParam);
    // Clean the Square redirect params out of the address bar.
    var clean = window.location.origin + window.location.pathname + (refParam ? '?ref=' + refParam : '');
    window.history.replaceState({}, '', clean);
  }
  $('claimSingleBtn').addEventListener('click', function () { submitClaim('single'); });
  $('claimBundleBtn').addEventListener('click', function () { submitClaim('bundle'); });
  function submitClaim(kind) {
    var msg = $('claimMsg');
    msg.className = 'form-msg';
    msg.textContent = '';
    var name = $('nameInput').value.trim();
    if (!name) { msg.classList.add('err'); msg.textContent = 'Enter your name above first, so the plays go to the right player.'; return; }
    msg.textContent = 'Claiming…';
    fetch('/api/payments/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerToken: playerToken, name: name, kind: kind,
        orderId: $('claimOrderId').value.trim() || undefined,
        receiptRef: $('claimReceipt').value.trim() || undefined,
      }),
    })
      .then(function (res) { return res.json(); })
      .then(function (d) {
        if (!d.ok) { msg.classList.add('err'); msg.textContent = d.error || 'Something went wrong.'; return; }
        msg.classList.add(d.status === 'confirmed' ? 'ok' : '');
        msg.textContent = d.message || '';
        if (d.status === 'confirmed') { $('claimOrderId').value = ''; $('claimReceipt').value = ''; }
        poll();
      })
      .catch(function () { msg.classList.add('err'); msg.textContent = 'Could not reach the game — try again.'; });
  }

  // ---- guess form -------------------------------------------------------------
  var nameInput = $('nameInput');
  var guessInput = $('guessInput');
  var formMsg = $('formMsg');
  if (myName) nameInput.value = myName;
  $('guessForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = nameInput.value.trim();
    var guess = parseInt(guessInput.value, 10);
    formMsg.className = 'form-msg';
    formMsg.textContent = '';
    if (!name) { formMsg.classList.add('err'); formMsg.textContent = 'Enter your name.'; return; }
    if (isNaN(guess) || guess < 0 || guess > 100) {
      formMsg.classList.add('err'); formMsg.textContent = 'Pick a whole number from 0 to 100.'; return;
    }
    var btn = $('guessBtn');
    btn.disabled = true;
    fetch('/api/guess', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerToken: playerToken, name: name, guess: guess }),
    })
      .then(function (res) { return res.json().then(function (d) { return { status: res.status, body: d }; }); })
      .then(function (r) {
        btn.disabled = false;
        var d = r.body;
        if (!d.ok) {
          formMsg.classList.add('err');
          formMsg.textContent = d.error || 'Something went wrong.';
          if (d.needsPayment) { $('buyBox').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
          return;
        }
        myName = d.name;
        localStorage.setItem('stw247_name', myName);
        formMsg.classList.add('ok');
        formMsg.textContent = 'Locked in! ' + d.name + ' — ' + d.guess + ' (' + (d.creditType === 'paid' ? '$5 play' : 'free play') + '). Good luck.';
        guessInput.value = '';
        poll();
      })
      .catch(function () {
        btn.disabled = false;
        formMsg.classList.add('err');
        formMsg.textContent = 'Could not reach the game — check your connection and try again.';
      });
  });

  // ---- referral copy ----------------------------------------------------------
  $('copyRefBtn').addEventListener('click', function () {
    var input = $('refLink');
    input.select();
    var done = function (ok) { $('copyRefBtn').textContent = ok ? 'Copied!' : 'Copy link'; setTimeout(function () { $('copyRefBtn').textContent = 'Copy link'; }, 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).then(function () { done(true); }, function () { done(document.execCommand('copy')); });
    } else { done(document.execCommand('copy')); }
  });

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { drawWheel(); });
  }
  registerPlayer().then(function () { poll(); });
  setInterval(poll, 3000);
  requestAnimationFrame(frame);
})();
