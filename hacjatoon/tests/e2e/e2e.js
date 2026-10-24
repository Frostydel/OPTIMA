const { chromium } = require('playwright');
const BASE = 'http://localhost:8765';
const CHROME = '/home/claude/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome';
let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { (c ? pass++ : fail++); console.log((c ? 'PASS' : 'FAIL') + '  ' + name + (c ? '' : '  ' + extra)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const state = async () => (await fetch(BASE + '/_state')).json();

// Records spoken utterances; speechSynthesis in headless has no voices.
const TTS_STUB = `
  window.__spoken = []; window.__cancels = 0;
  const synth = { speak(u){ window.__spoken.push({text:u.text, lang:u.lang}); }, cancel(){ window.__cancels++; },
                  getVoices(){ return []; }, addEventListener(){} };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = function(t){ this.text = t; };
`;

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: [
    '--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const ctx = await browser.newContext({ permissions: ['camera'] });
  const page = await ctx.newPage();
  await page.addInitScript(TTS_STUB);
  const reqs = [];
  page.on('request', r => { if (r.url().endsWith('/analyze')) reqs.push(JSON.parse(r.postData())); });
  await page.goto(BASE);
  await fetch(BASE + '/_reset', { method: 'POST' });

  // 1. start/stop webcam
  await page.click('#startCam');
  await page.waitForFunction(() => document.getElementById('video').videoWidth > 0, null, { timeout: 8000 });
  ok(await page.isDisabled('#startCam') && await page.isEnabled('#stopCam'), '1a camera starts, controls update');
  ok(await page.isVisible('#video'), '1b live feed visible');

  // 2 + 3 + 4. frame reaches /analyze; four actions; spoken
  for (const action of ['describe', 'read', 'translate', 'explain']) {
    await page.selectOption('#action', action);
    await page.selectOption('#language', action === 'translate' ? 'French' : 'English');
    if (action === 'explain') await page.fill('#question', 'What is this?');
    const before = reqs.length;
    await page.click('#analyzeNow');
    await page.waitForFunction(n => document.querySelectorAll('#results li').length >= n, before + 1, { timeout: 8000 });
    const r = reqs[reqs.length - 1];
    ok(r.action === action && Object.keys(r).sort().join() === 'action,image_base64,language,question', `3 action "${action}" sent with exact contract`, JSON.stringify(Object.keys(r)));
    ok(r.image_base64.startsWith('data:image/jpeg;base64,'), `2 frame is JPEG data URL (${action})`);
  }
  const img = reqs[0].image_base64; const kb = Math.round(img.length * 0.75 / 1024);
  ok(kb < 2000, `2 frame size reasonable (${kb} KB)`);
  const dims = await page.evaluate(src => new Promise(res => { const i = new Image(); i.onload = () => res([i.width, i.height]); i.src = src; }), img);
  ok(Math.max(...dims) <= 1280, `2 frame resized to <=1280 (${dims.join('x')})`);
  ok(reqs[3].question === 'What is this?', '3 optional question forwarded');
  ok(reqs[2].language === 'French', '3 language forwarded');
  const spoken = await page.evaluate(() => window.__spoken);
  ok(spoken.length >= 1 && spoken[0].text.includes('Test description'), '4 response spoken', JSON.stringify(spoken));
  ok(spoken.some(s => s.lang === 'fr-FR'), '4 French TTS language tag used');
  ok(await page.locator('#results li').count() >= 1, '4 response displayed on screen');
  const cancels0 = await page.evaluate(() => window.__cancels);
  await page.click('#stopSpeaking');
  ok(await page.evaluate(() => window.__cancels) > cancels0, '4 Stop speaking cancels speech');

  // arabic tag
  await page.selectOption('#language', 'Arabic'); await page.selectOption('#action', 'describe');
  await page.click('#analyzeNow'); await page.waitForFunction(() => window.__spoken.some(s => s.lang === 'ar-SA'), null, { timeout: 8000 });
  ok(true, '4 Arabic TTS language tag used');

  // 5. Live Assist: sequential, repeated
  await page.selectOption('#language', 'English'); await page.fill('#question', '');
  await page.selectOption('#interval', '3');
  await fetch(BASE + '/_reset', { method: 'POST' }); reqs.length = 0;
  await page.uncheck('#skipUnchanged');
  const spokenBeforeLive = await page.evaluate(() => window.__spoken.length);
  await page.click('#liveStart');
  await page.waitForSelector('#loading:not([hidden])', { timeout: 4000 });
  ok(true, '5 loading indicator shown while analyzing');
  await sleep(14000);
  let s = await state();
  ok(s.n >= 3, `5 Live Assist analyzed repeatedly (${s.n} requests)`);
  ok(s.max_active === 1, `5 no overlapping requests (max concurrent = ${s.max_active})`);
  ok(s.prompts.some(p => p.includes('at most two short sentences')), '5 live mode asks for concise answers');
  const entries = await page.locator('#results li').count();
  const spokenTexts = await page.evaluate(n => window.__spoken.slice(n).map(x => x.text), spokenBeforeLive);
  const dup = spokenTexts.some((t, i) => i && t === spokenTexts[i - 1]);
  ok(s.n > spokenTexts.length && !dup, `4 repeated identical description not re-spoken (${s.n} answers, ${spokenTexts.length} spoken)`, JSON.stringify(spokenTexts));

  // scene-change suppression: stop, enable skipping, static fake camera => few requests
  await page.click('#liveStop'); await sleep(1200);
  await fetch(BASE + '/_reset', { method: 'POST' });
  await page.check('#skipUnchanged'); await page.click('#liveStart');
  await sleep(11000);
  const sup = await state();
  ok(sup.n <= 2 && /unchanged/i.test(await page.textContent('#status')), `5 unchanged scene suppressed (${sup.n} requests in 11 s)`, await page.textContent('#status'));
  await page.click('#liveStop'); await sleep(1200);
  await page.uncheck('#skipUnchanged'); await page.click('#liveStart');
  await sleep(2000);

  // 6. Pause + Resume + Stop
  await page.click('#livePause');
  await sleep(1500);
  const nPaused = (await state()).n;
  await sleep(6000);
  ok((await state()).n === nPaused, `6 Pause stops further analysis (${nPaused})`);
  ok((await page.textContent('#livePause')) === 'Resume', '6 Pause button becomes Resume');
  await page.click('#livePause');
  await sleep(5000);
  ok((await state()).n > nPaused, '6 Resume continues analysis');
  await page.click('#liveStop');
  await sleep(1500);
  const nStop = (await state()).n;
  await sleep(7000);
  ok((await state()).n === nStop, `6 Stop terminates analysis (${nStop})`);
  ok(await page.isDisabled('#livePause') && await page.isEnabled('#liveStart'), '6 controls reset after Stop');

  // pause mid-request aborts it (no response rendered afterwards)
  await fetch(BASE + '/_reset', { method: 'POST' });
  const cnt = await page.locator('#results li').count();
  await page.click('#liveStart'); await page.waitForSelector('#loading:not([hidden])');
  await page.click('#livePause'); await sleep(1500);
  ok(await page.locator('#results li').count() === cnt && await page.isHidden('#loading'), '6 Pause mid-request discards in-flight call');
  await page.click('#liveStop');

  // 7. API/network failures
  await page.route('**/analyze', r => r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ detail: 'Gemma API request failed (HTTP 503).' }) }));
  await page.click('#analyzeNow');
  await page.waitForFunction(() => document.getElementById('error').textContent.length > 0);
  ok((await page.textContent('#error')).includes('HTTP 503'), '7 API failure message shown', await page.textContent('#error'));
  await page.unroute('**/analyze');
  await page.route('**/analyze', r => r.abort('failed'));
  await page.click('#analyzeNow');
  await page.waitForFunction(() => /Cannot reach/.test(document.getElementById('error').textContent));
  ok(true, '7 network failure message shown');
  await page.unroute('**/analyze');
  await page.route('**/analyze', r => r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ detail: 'Image is invalid, too large to process safely, or cannot be decoded.' }) }));
  await page.click('#analyzeNow');
  await page.waitForFunction(() => /invalid/.test(document.getElementById('error').textContent));
  ok(true, '7 invalid image message shown');
  await page.unroute('**/analyze');

  // live auto-pauses after repeated errors
  await page.route('**/analyze', r => r.fulfill({ status: 502, contentType: 'application/json', body: '{"detail":"down"}' }));
  await page.selectOption('#interval', '3');
  await page.click('#liveStart');
  await page.waitForFunction(() => /paused after repeated errors/.test(document.getElementById('error').textContent), null, { timeout: 90000 });
  ok(await page.textContent('#livePause') === 'Resume', '7 Live Assist auto-pauses after repeated errors');
  await page.click('#liveStop'); await page.unroute('**/analyze');

  // camera disconnect
  await page.click('#liveStart'); await sleep(500);
  await page.evaluate(() => { const t = document.getElementById('video').srcObject.getVideoTracks()[0]; t.stop(); t.dispatchEvent(new Event('ended')); });
  await sleep(300);
  ok(/disconnected/.test(await page.textContent('#error')) && await page.isEnabled('#startCam'), '7 camera disconnect handled, live stopped');
  ok(await page.isDisabled('#liveStop'), '7 live state cleared on disconnect');

  // stop camera
  await page.click('#startCam'); await page.waitForFunction(() => document.getElementById('video').videoWidth > 0);
  await page.click('#stopCam');
  ok(await page.isDisabled('#stopCam') && await page.isHidden('#video'), '1c camera stops');

  // 8. upload still works
  await fetch(BASE + '/_reset', { method: 'POST' }); reqs.length = 0;
  await page.setInputFiles('#file', '../../_smoke_test.png');
  await page.waitForFunction(() => !document.getElementById('uploadAnalyze').disabled);
  await page.selectOption('#action', 'read');
  const before = await page.locator('#results li').count();
  await page.click('#uploadAnalyze');
  await page.waitForFunction(n => document.querySelectorAll('#results li').length > n, before, { timeout: 8000 }).catch(() => {});
  ok(reqs.length === 1 && reqs[0].image_base64.startsWith('data:image/png'), '8 uploaded image reaches /analyze');
  await page.setInputFiles('#file', { name: 'x.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
  ok(/Unsupported/.test(await page.textContent('#error')), '8 unsupported upload rejected client-side');

  // a11y
  const unlabeled = await page.$$eval('button', bs => bs.filter(b => !(b.getAttribute('aria-label') || b.textContent.trim())).length);
  ok(unlabeled === 0, '5 all buttons have accessible names');
  ok(await page.getAttribute('#status', 'role') === 'status' && await page.getAttribute('#error', 'role') === 'alert', '5 status + alert live regions present');
  await page.focus('#action'); await page.keyboard.press('Tab');
  ok(await page.evaluate(() => document.activeElement.id) === 'language', '5 keyboard Tab moves between controls');
  await ctx.close();

  // camera permission denied / no camera / insecure
  for (const [name, err, re] of [['denied', 'NotAllowedError', /permission was denied/], ['no camera', 'NotFoundError', /No camera was found/], ['busy', 'NotReadableError', /busy or unavailable/]]) {
    const c = await browser.newContext(); const p = await c.newPage();
    await p.addInitScript(e => { navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('x'), { name: e })); }, err);
    await p.goto(BASE); await p.click('#startCam');
    await p.waitForFunction(() => document.getElementById('error').textContent.length > 0);
    ok(re.test(await p.textContent('#error')) && await p.isEnabled('#startCam'), `7 camera ${name} -> clear message, can retry`);
    await c.close();
  }
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('E2E CRASH', e); process.exit(2); });
