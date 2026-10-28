// ==UserScript==
// @name         DK – Milisekundy u serverového času
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Serverový čas s milisekundami, čas příchodu s ms, kalibrace zpoždění a odpočet na cílový příchod (přepínatelné). Pouze zobrazení, nic neposílá – klikáš ty.
// @match        https://*.divokekmeny.cz/game.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const DAY = 86400000;
    const RESYNC_MS = 30000;      // jak často znovu srovnat s hodinami hry
    const MAX_RESIDUAL_MS = 2000; // když Timing nesedí s hodinami hry víc než o tohle, přepne se na záložní režim
    const MAX_SAMPLES = 7;        // kolik posledních měření se drží (bere se medián)
    const MAX_CAL_DIFF = 2000;    // větší rozdíl při kalibraci = překlep
    const MAX_REACT = 1000;       // klik dál než 1 s od signálu se do reakce nepočítá
    const BAR_MS = 2000;          // jak dlouho před signálem se plní pruh
    const NOW_WINDOW = 250;       // jak dlouho svítí "TEĎ!"

    const LS = {
        cal: 'dkMs_calSamples',
        lastPred: 'dkMs_lastPred',
        mode: 'dkMs_mode',
        target: 'dkMs_target',
        react: 'dkMs_reactSamples',
        sound: 'dkMs_sound',
        lastShot: 'dkMs_lastShot',
    };

    const orig = document.getElementById('serverTime');
    if (!orig) return;

    // ---------- pomocné funkce ----------
    const hasTiming = () => !!(window.Timing && typeof window.Timing.getCurrentServerTime === 'function');
    const pad = (n, l = 2) => String(n).padStart(l, '0');
    const tod = (x) => ((x % DAY) + DAY) % DAY;

    function lsGet(key, def) {
        try { const v = localStorage.getItem(key); return v === null ? def : JSON.parse(v); } catch (e) { return def; }
    }
    function lsSet(key, val) {
        try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* nic */ }
    }

    function parseHMS(text) {
        const m = /(\d{1,2}):(\d{2}):(\d{2})/.exec(text || '');
        if (!m) return null;
        return ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000;
    }

    // "08:11:36:412" / "08:11:36.412" -> ms dne
    function parseHMSms(text) {
        const m = /(\d{1,2}):(\d{2}):(\d{2})[:.,](\d{1,3})/.exec(text || '');
        if (!m) return null;
        return ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + Number(m[4].padEnd(3, '0'));
    }

    // cílový čas: s ms i bez nich
    function parseTarget(text) {
        const a = parseHMSms(text);
        return a !== null ? a : parseHMS(text);
    }

    // doba letu "0:58:49", "27:13:05" nebo "1:03:13:05" (dny:h:m:s)
    function parseDuration(text) {
        const m = /(\d+(?::\d{2}){2,3})/.exec(text || '');
        if (!m) return null;
        const p = m[1].split(':').map(Number);
        const s = p.length === 4
            ? p[0] * 86400 + p[1] * 3600 + p[2] * 60 + p[3]
            : p[0] * 3600 + p[1] * 60 + p[2];
        return s * 1000;
    }

    // převede rozdíl do intervalu [-12h, +12h)
    function wrap(x) {
        x = tod(x);
        return x >= DAY / 2 ? x - DAY : x;
    }

    function fmt(ms) {
        const t = tod(ms);
        return `${pad(Math.floor(t / 3600000))}:${pad(Math.floor(t / 60000) % 60)}:${pad(Math.floor(t / 1000) % 60)}:${pad(Math.floor(t % 1000), 3)}`;
    }

    const signed = (n) => `${n > 0 ? '+' : ''}${n}`;

    function median(arr) {
        if (!arr.length) return 0;
        const s = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(s.length / 2);
        return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
    }

    // ---------- kalibrace sítě + reakce ----------
    // correction = o kolik se posunout, aby hodiny ukazovaly čas, který si server zapíše při kliknutí teď
    let calSamples = lsGet(LS.cal, []);
    let correction = median(calSamples);
    // reaction = jak dlouho po signálu odpočtu reálně klikneš (učí se samo)
    let reactSamples = lsGet(LS.react, []);
    let reaction = median(reactSamples);

    function saveCal() { lsSet(LS.cal, calSamples); correction = median(calSamples); }
    function saveReact() { lsSet(LS.react, reactSamples); reaction = median(reactSamples); }

    let mode = lsGet(LS.mode, 'clock') === 'countdown' ? 'countdown' : 'clock';
    let soundOn = !!lsGet(LS.sound, false);

    // ---------- synchronizace se serverovým časem ----------
    let syncMode = hasTiming() ? 'timing' : 'fallback';
    let offset = null;
    const tickSamples = [];
    let lastText = orig.textContent;

    function base() {
        return syncMode === 'timing' ? window.Timing.getCurrentServerTime() : Date.now();
    }

    const rawNow = () => base() + offset;          // bez kalibrace
    const corrNow = () => rawNow() + correction;   // s kalibrací

    function syncTiming() {
        const disp = parseHMS(orig.textContent);
        if (disp === null) return;
        const diff = wrap(disp - (base() % DAY));
        const rounded = Math.round(diff / 60000) * 60000; // časová zóna = celé minuty
        if (Math.abs(diff - rounded) > MAX_RESIDUAL_MS) {
            syncMode = 'fallback';
            offset = null;
            tickSamples.length = 0;
            return;
        }
        offset = rounded;
    }

    function onGameTick() {
        const text = orig.textContent;
        if (text === lastText) return;
        lastText = text;
        if (syncMode !== 'fallback') return;
        const disp = parseHMS(text);
        if (disp === null) return;
        // hra přepisuje čas chvíli PO přelomu sekundy, takže největší vzorek je nejpřesnější
        tickSamples.push(wrap(disp - (Date.now() % DAY)));
        if (tickSamples.length > 15) tickSamples.shift();
        offset = Math.max(...tickSamples);
    }

    new MutationObserver(onGameTick).observe(orig, { childList: true, characterData: true, subtree: true });

    if (syncMode === 'timing') syncTiming();

    setInterval(() => {
        if (syncMode === 'fallback' && hasTiming() && tickSamples.length === 0) syncMode = 'timing';
        if (syncMode === 'timing') syncTiming();
    }, RESYNC_MS);

    // ---------- hodiny ----------
    // kind: 'now' = aktuální serverový čas, 'arrival' = příchod při odeslání teď
    const clocks = [];

    function makeClock(kind, style, durMs) {
        const el = document.createElement('span');
        el.className = 'dk-ms';
        el.style.fontVariantNumeric = 'tabular-nums';
        el.style.cursor = 'pointer';
        el.title = (kind === 'arrival' ? 'Příchod s milisekundami (kdybys odeslal teď)' : 'Serverový čas s milisekundami') +
            ' – klikni pro kalibraci';
        const prefix = document.createElement('span');
        const main = document.createElement('span');
        const ms = document.createElement('span');
        ms.style.color = '#c00';
        ms.style.fontWeight = 'bold';
        el.append(prefix, main, ms);

        if (style === 'big') {
            el.style.cssText += ';display:inline-block;padding:3px 8px;' +
                'font:bold 16px monospace;background:#fff8e6;border:1px solid #7d510f;border-radius:3px;vertical-align:middle;';
        } else if (style === 'arrival') {
            el.style.fontWeight = 'bold';
        }

        el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); togglePanel(); });

        clocks.push({ el, kind, durMs: durMs || 0, prefix, main, ms, lastPrefix: null, lastMain: '', lastMs: '' });
        return el;
    }

    // dole u serverového času
    const footerClock = makeClock('now', 'footer');
    footerClock.className += ' ' + orig.className;
    footerClock.id = 'dk-ms-clock';
    footerClock.style.display = 'none';
    orig.insertAdjacentElement('afterend', footerClock);

    // ---------- potvrzovací okno ----------
    function findConfirmButton() {
        const b = document.querySelector('#troop_confirm_submit, #troop_confirm_go, .troop_confirm_go');
        if (b) return b;
        for (const el of document.querySelectorAll('button, input[type=submit], input[type=button], a.btn')) {
            const t = (el.value || el.textContent || '').trim();
            if (/^Poslat (útok|podporu)/i.test(t)) return el;
        }
        return null;
    }

    function findRowValue(label) {
        for (const td of document.querySelectorAll('td, th')) {
            if (td.textContent.trim() === label && td.nextElementSibling) return td.nextElementSibling;
        }
        return null;
    }

    function currentDur() {
        const arr = clocks.find(c => c.kind === 'arrival' && c.el.isConnected);
        if (arr) return arr.durMs;
        const durCell = findRowValue('Trvání:');
        return durCell ? parseDuration(durCell.textContent) : null;
    }

    // zastaví Enter/klávesy, aby se náhodou neodeslal formulář s útokem
    function shield(el) {
        ['keydown', 'keypress', 'keyup'].forEach(ev => el.addEventListener(ev, (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') e.preventDefault();
        }));
    }

    function smallBtn(label, title) {
        const b = document.createElement('button');
        b.type = 'button'; // NIKDY submit
        b.className = 'btn';
        b.textContent = label;
        if (title) b.title = title;
        b.style.cssText = 'margin-left:6px;padding:2px 6px;font-size:11px;vertical-align:middle;';
        return b;
    }

    const widgets = []; // {clockWrap, cdBox, input, txt, fill, info, sndBtn, targetAbs, cueAbs, beepKey}

    function buildConfirmWidgets(btn) {
        // režim HODINY – velké hodiny vedle tlačítka
        const clockWrap = document.createElement('span');
        clockWrap.className = 'dk-ms';
        clockWrap.style.marginLeft = '10px';
        clockWrap.appendChild(makeClock('now', 'big'));
        const toCd = smallBtn('⇄ Odpočet', 'Přepnout na odpočet');
        clockWrap.appendChild(toCd);

        // režim ODPOČET
        const cdBox = document.createElement('div');
        cdBox.className = 'dk-ms';
        cdBox.style.cssText = 'margin-top:8px;padding:6px 8px;background:#fff8e6;border:1px solid #7d510f;border-radius:3px;max-width:520px;';
        cdBox.innerHTML = `
            <div style="margin-bottom:5px;">
                🎯 Cílový příchod:
                <input data-tgt type="text" placeholder="08:11:36:500" style="width:110px;font:bold 13px monospace;">
            </div>
            <div data-txt style="font:bold 18px monospace;padding:2px 4px;border-radius:3px;">Zadej cílový příchod</div>
            <div style="position:relative;height:14px;margin:5px 0;background:#e8dcc0;border:1px solid #7d510f;">
                <div data-fill style="height:100%;width:0;background:#e0a030;"></div>
                <div style="position:absolute;right:0;top:-4px;bottom:-4px;width:3px;background:#000;"></div>
            </div>
            <div data-info style="font-size:11px;color:#444;"></div>`;
        const head = cdBox.firstElementChild;
        const sndBtn = smallBtn(soundOn ? '🔊' : '🔇', 'Pípání: 2 krátká + klikni na třetí');
        const toClock = smallBtn('⇄ Hodiny', 'Přepnout na hodiny');
        head.append(sndBtn, toClock);

        const input = cdBox.querySelector('[data-tgt]');
        input.value = lsGet(LS.target, '') || '';
        shield(input);
        input.addEventListener('input', () => lsSet(LS.target, input.value.trim()));

        toCd.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); setMode('countdown'); });
        toClock.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); setMode('clock'); });
        sndBtn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            soundOn = !soundOn;
            lsSet(LS.sound, soundOn);
            if (soundOn) ensureAudio();
            widgets.forEach(w => { w.sndBtn.textContent = soundOn ? '🔊' : '🔇'; cancelBeeps(w); });
        });

        btn.insertAdjacentElement('afterend', clockWrap);
        clockWrap.insertAdjacentElement('afterend', cdBox);

        const w = {
            clockWrap, cdBox, input, sndBtn,
            txt: cdBox.querySelector('[data-txt]'),
            fill: cdBox.querySelector('[data-fill]'),
            info: cdBox.querySelector('[data-info]'),
            targetAbs: null, cueAbs: null, beepKey: null, beepNodes: [],
        };
        widgets.push(w);
        applyMode();
    }

    function applyMode() {
        for (const w of widgets) {
            w.clockWrap.style.display = mode === 'clock' ? '' : 'none';
            w.cdBox.style.display = mode === 'countdown' ? '' : 'none';
            if (mode !== 'countdown') cancelBeeps(w);
        }
    }

    function setMode(m) {
        mode = m;
        lsSet(LS.mode, m);
        applyMode();
    }

    // ---------- zvuk ----------
    let audioCtx = null;

    function ensureAudio() {
        try {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') audioCtx.resume();
        } catch (e) { audioCtx = null; }
    }

    function cancelBeeps(w) {
        for (const o of w.beepNodes) { try { o.stop(); } catch (e) { /* už skončil */ } }
        w.beepNodes = [];
        w.beepKey = null;
    }

    function scheduleBeeps(w, nowAbs) {
        if (!audioCtx || audioCtx.state !== 'running') return;
        cancelBeeps(w);
        const latency = (audioCtx.baseLatency || 0) + (audioCtx.outputLatency || 0);
        const beeps = [[-1000, 660, 0.06], [-500, 660, 0.06], [0, 990, 0.12]];
        for (const [rel, freq, len] of beeps) {
            const inMs = w.cueAbs + rel - nowAbs;
            if (inMs < 20) continue;
            const at = audioCtx.currentTime + inMs / 1000 - latency;
            const o = audioCtx.createOscillator();
            const g = audioCtx.createGain();
            o.frequency.value = freq;
            g.gain.setValueAtTime(0.25, at);
            g.gain.exponentialRampToValueAtTime(0.001, at + len);
            o.connect(g).connect(audioCtx.destination);
            o.start(at);
            o.stop(at + len + 0.02);
            w.beepNodes.push(o);
        }
        w.beepKey = Math.round(w.cueAbs);
    }

    // ---------- kliknutí na "Poslat útok" ----------
    function onSendPress() {
        if (offset === null) return;
        const dur = currentDur();
        if (dur === null) return;
        const raw = rawNow();

        // pro kalibraci sítě (bez korekce)
        lsSet(LS.lastPred, { pred: tod(raw + dur), at: Date.now() });

        // pro odpočet
        const w = widgets.find(x => x.cdBox.isConnected);
        if (mode === 'countdown' && w && w.targetAbs !== null) {
            const predArr = raw + correction + dur;
            const err = Math.round(predArr - w.targetAbs);
            const delay = err + reaction; // jak dlouho po signálu jsi kliknul
            if (Math.abs(delay) <= MAX_REACT) {
                reactSamples.push(delay);
                if (reactSamples.length > MAX_SAMPLES) reactSamples.shift();
                saveReact();
            }
            const shot = { target: tod(w.targetAbs), pred: tod(predArr), err, at: Date.now(), shown: false };
            lsSet(LS.lastShot, shot);
            showShotToast(shot);
            // když se stránka nepřenačte (popup), označ jako zobrazené; jinak se ukáže po načtení
            setTimeout(() => { const s = lsGet(LS.lastShot, null); if (s && s.at === shot.at) { s.shown = true; lsSet(LS.lastShot, s); } }, 1500);
        }
        updatePanel();
    }

    function scanConfirm() {
        const btn = findConfirmButton();
        if (btn && !btn.dataset.dkMs) {
            btn.dataset.dkMs = '1';
            btn.addEventListener('mousedown', onSendPress, true); // mousedown = co nejblíž stisku
            btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') onSendPress(); }, true);
            buildConfirmWidgets(btn);
        }

        const arrCell = findRowValue('Příchod:');
        const durCell = findRowValue('Trvání:');
        if (arrCell && durCell && !arrCell.dataset.dkMs) {
            const dur = parseDuration(durCell.textContent);
            if (dur === null) return;
            arrCell.dataset.dkMs = '1';
            // původní text hry schovat (hra ho dál může aktualizovat, jen není vidět)
            const hidden = document.createElement('span');
            hidden.style.display = 'none';
            while (arrCell.firstChild) hidden.appendChild(arrCell.firstChild);
            arrCell.appendChild(hidden);
            arrCell.appendChild(makeClock('arrival', 'arrival', dur));
        }
    }

    // ---------- toast s výsledkem ----------
    function showShotToast(shot) {
        const old = document.getElementById('dk-ms-toast');
        if (old) old.remove();
        const abs = Math.abs(shot.err);
        const color = abs <= 50 ? '#2e7d32' : abs <= 150 ? '#e08a00' : '#c62828';
        const t = document.createElement('div');
        t.id = 'dk-ms-toast';
        t.className = 'dk-ms';
        t.style.cssText = `position:fixed;top:70px;left:50%;transform:translateX(-50%);z-index:100001;padding:8px 14px;` +
            `background:#fff8e6;border:2px solid ${color};border-radius:4px;font:bold 13px Verdana,Arial,sans-serif;` +
            `box-shadow:0 2px 8px rgba(0,0,0,.4);cursor:pointer;`;
        t.innerHTML = `🎯 Příchod <span style="font-family:monospace">${fmt(shot.pred)}</span> · cíl ` +
            `<span style="font-family:monospace">${fmt(shot.target)}</span> · ` +
            `<span style="color:${color}">${signed(shot.err)} ms</span>`;
        t.title = 'Odhad podle kalibrace – skutečný příchod ověř v příkazu';
        t.onclick = () => t.remove();
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 8000);
    }

    (function showPendingShot() {
        const s = lsGet(LS.lastShot, null);
        if (s && !s.shown && Date.now() - s.at < 15000) {
            showShotToast(s);
            s.shown = true;
            lsSet(LS.lastShot, s);
        }
    })();

    // ---------- kalibrační panel ----------
    let panel = null;

    function buildPanel() {
        panel = document.createElement('div');
        panel.className = 'dk-ms';
        panel.style.cssText = 'position:fixed;right:12px;bottom:40px;z-index:100000;width:300px;padding:10px 12px;' +
            'background:#f4e4bc;border:2px solid #7d510f;border-radius:4px;font:12px Verdana,Arial,sans-serif;' +
            'color:#000;box-shadow:0 2px 8px rgba(0,0,0,.4);display:none;';
        panel.innerHTML = `
            <div style="font-weight:bold;margin-bottom:6px;">⏱️ Kalibrace milisekund
                <span data-x style="float:right;cursor:pointer;">✖</span></div>
            <div style="margin-bottom:4px;">Korekce sítě: <b data-corr></b> <span data-cnt style="color:#555"></span></div>
            <div style="margin-bottom:4px;">Poslední odeslání – skript ukazoval:<br><b data-pred></b></div>
            <div style="margin-bottom:4px;">Skutečný příchod z příkazu (celý čas nebo jen ms):</div>
            <input data-in type="text" placeholder="08:11:36:412 nebo 412" style="width:150px;">
            <button data-save type="button" class="btn" style="margin-left:4px;">Uložit</button>
            <div style="margin-top:6px;">
                Ruční korekce: <input data-man type="number" step="1" style="width:60px;"> ms
                <button data-setman type="button" class="btn">Nastavit</button>
            </div>
            <div style="margin-top:4px;"><button data-reset type="button" class="btn">Vynulovat korekci sítě</button></div>
            <hr style="border:none;border-top:1px solid #7d510f;margin:8px 0;">
            <div style="margin-bottom:4px;">Reakce (odpočet): <b data-react></b> <span data-rcnt style="color:#555"></span></div>
            <div>
                Ručně: <input data-rman type="number" step="1" style="width:60px;"> ms
                <button data-rset type="button" class="btn">Nastavit</button>
                <button data-rreset type="button" class="btn">Vynulovat</button>
            </div>
            <div data-msg style="margin-top:6px;color:#7d510f;min-height:14px;"></div>`;
        document.body.appendChild(panel);
        panel.querySelectorAll('input').forEach(shield);

        const q = (s) => panel.querySelector(s);
        q('[data-x]').onclick = () => { panel.style.display = 'none'; };
        q('[data-save]').onclick = saveCalibration;
        q('[data-in]').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveCalibration(); });
        q('[data-setman]').onclick = () => {
            const v = Math.round(Number(q('[data-man]').value));
            if (!Number.isFinite(v) || Math.abs(v) > MAX_CAL_DIFF) { msg('Neplatná hodnota.'); return; }
            calSamples = [v]; saveCal();
            msg(`Korekce sítě nastavena na ${signed(v)} ms.`); updatePanel();
        };
        q('[data-reset]').onclick = () => { calSamples = []; saveCal(); msg('Korekce sítě vynulována.'); updatePanel(); };
        q('[data-rset]').onclick = () => {
            const v = Math.round(Number(q('[data-rman]').value));
            if (!Number.isFinite(v) || Math.abs(v) > MAX_REACT) { msg('Neplatná hodnota.'); return; }
            reactSamples = [v]; saveReact();
            msg(`Reakce nastavena na ${v} ms.`); updatePanel();
        };
        q('[data-rreset]').onclick = () => { reactSamples = []; saveReact(); msg('Reakce vynulována.'); updatePanel(); };
    }

    function msg(t) { if (panel) panel.querySelector('[data-msg]').textContent = t; }

    function saveCalibration() {
        const last = lsGet(LS.lastPred, null);
        if (!last) { msg('Nejdřív odešli útok s otevřeným potvrzením.'); return; }
        const text = panel.querySelector('[data-in]').value.trim();
        let diff;
        const full = parseHMSms(text);
        if (full !== null) {
            diff = wrap(full - last.pred);
        } else if (/^\d{1,3}$/.test(text)) {
            diff = Number(text.padEnd(3, '0')) - (last.pred % 1000);
            if (diff >= 500) diff -= 1000;
            if (diff < -500) diff += 1000;
        } else {
            msg('Zadej čas jako 08:11:36:412 nebo jen 412.');
            return;
        }
        if (Math.abs(diff) > MAX_CAL_DIFF) { msg(`Rozdíl ${diff} ms je moc velký, asi překlep.`); return; }
        calSamples.push(diff);
        if (calSamples.length > MAX_SAMPLES) calSamples.shift();
        saveCal();
        panel.querySelector('[data-in]').value = '';
        msg(`Rozdíl ${signed(diff)} ms uložen.`);
        updatePanel();
    }

    function updatePanel() {
        if (!panel) return;
        const last = lsGet(LS.lastPred, null);
        panel.querySelector('[data-corr]').textContent = `${signed(correction)} ms`;
        panel.querySelector('[data-cnt]').textContent = calSamples.length ? `(z ${calSamples.length}: ${calSamples.join(', ')})` : '(zatím žádné měření)';
        panel.querySelector('[data-pred]').textContent = last ? fmt(last.pred) : '—';
        panel.querySelector('[data-react]').textContent = `${reaction} ms`;
        panel.querySelector('[data-rcnt]').textContent = reactSamples.length ? `(z ${reactSamples.length}: ${reactSamples.join(', ')})` : '(zatím žádné měření)';
    }

    function togglePanel() {
        if (!panel) buildPanel();
        const open = panel.style.display === 'none';
        panel.style.display = open ? 'block' : 'none';
        if (open) { updatePanel(); msg(''); }
    }

    // ---------- sledování stránky ----------
    let scanQueued = false;
    new MutationObserver((muts) => {
        const relevant = muts.some(m => {
            const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
            return !(t && t.closest && t.closest('.dk-ms'));
        });
        if (!relevant || scanQueued) return;
        scanQueued = true;
        requestAnimationFrame(() => { scanQueued = false; scanConfirm(); });
    }).observe(document.body, { childList: true, subtree: true });

    scanConfirm();

    // ---------- vykreslování ----------
    let shown = false;

    function dayPrefix(nowAbs, arrAbs) {
        const d = Math.floor(arrAbs / DAY) - Math.floor(nowAbs / DAY);
        if (d <= 0) return 'dnes v ';
        if (d === 1) return 'zítra v ';
        return `za ${d} dní v `;
    }

    function setTxt(w, text, bg, color) {
        if (w.txt.textContent !== text) w.txt.textContent = text;
        w.txt.style.background = bg;
        w.txt.style.color = color;
    }

    function renderCountdown(w, nowAbs) {
        const dur = currentDur();
        const tgt = parseTarget(w.input.value.trim());
        if (dur === null || tgt === null) {
            w.targetAbs = null; w.cueAbs = null;
            setTxt(w, 'Zadej cílový příchod', 'transparent', '#000');
            w.fill.style.width = '0';
            w.info.textContent = '';
            cancelBeeps(w);
            return;
        }

        // nejbližší příchod v cílový čas (dnes, případně zítra)
        let targetAbs = Math.floor(nowAbs / DAY) * DAY + tgt;
        while (targetAbs < nowAbs + dur - 600000) targetAbs += DAY;
        const sendAbs = targetAbs - dur;      // kdy musí server útok zapsat
        const cueAbs = sendAbs - reaction;    // kdy ti dát signál
        w.targetAbs = targetAbs;
        w.cueAbs = cueAbs;

        const remaining = cueAbs - nowAbs;

        if (remaining > 0) {
            const s = (remaining / 1000).toFixed(3);
            setTxt(w, `Klikni za ${s} s`, remaining < 500 ? '#ffe0a0' : 'transparent', '#000');
        } else if (remaining > -NOW_WINDOW) {
            setTxt(w, 'TEĎ!', '#2e7d32', '#fff');
        } else {
            setTxt(w, `Pozdě o ${(-remaining / 1000).toFixed(3)} s`, '#c62828', '#fff');
        }

        const p = Math.max(0, Math.min(1, (BAR_MS - remaining) / BAR_MS));
        w.fill.style.width = (p * 100).toFixed(1) + '%';
        w.fill.style.background = remaining <= 0 && remaining > -NOW_WINDOW ? '#2e7d32' : remaining <= 0 ? '#c62828' : '#e0a030';

        const info = `Odeslat v ${fmt(sendAbs)} · reakce ${reaction} ms · signál v ${fmt(cueAbs)}`;
        if (w.info.textContent !== info) w.info.textContent = info;

        // pípání: naplánuj, když je signál blízko (a přeplánuj, kdyby se změnil cíl/reakce)
        if (soundOn && remaining > 0 && remaining < 1600) {
            if (w.beepKey === null || Math.abs(w.beepKey - cueAbs) > 5) scheduleBeeps(w, nowAbs);
        } else if (remaining >= 1600 && w.beepKey !== null) {
            cancelBeeps(w);
        }
    }

    function frame() {
        for (let i = clocks.length - 1; i >= 0; i--) {
            if (!clocks[i].el.isConnected) clocks.splice(i, 1);
        }
        for (let i = widgets.length - 1; i >= 0; i--) {
            if (!widgets[i].cdBox.isConnected) { cancelBeeps(widgets[i]); widgets.splice(i, 1); }
        }

        if (offset !== null) {
            if (!shown) {
                orig.style.display = 'none';
                footerClock.style.display = '';
                shown = true;
            }
            const nowAbs = corrNow();
            for (const c of clocks) {
                const abs = nowAbs + c.durMs;
                const t = tod(abs);
                const mainStr = `${Math.floor(t / 3600000)}:${pad(Math.floor(t / 60000) % 60)}:${pad(Math.floor(t / 1000) % 60)}`;
                const msStr = `:${pad(Math.floor(t % 1000), 3)}`;
                const prefixStr = c.kind === 'arrival' ? dayPrefix(nowAbs, abs) : '';
                if (c.lastPrefix !== prefixStr) { c.prefix.textContent = prefixStr; c.lastPrefix = prefixStr; }
                if (c.lastMain !== mainStr) { c.main.textContent = mainStr; c.lastMain = mainStr; }
                if (c.lastMs !== msStr) { c.ms.textContent = msStr; c.lastMs = msStr; }
            }
            if (mode === 'countdown') {
                for (const w of widgets) renderCountdown(w, nowAbs);
            }
        } else if (shown) {
            orig.style.display = '';
            footerClock.style.display = 'none';
            shown = false;
        }
        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
})();
