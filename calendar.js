'use strict';
/* Oscar 日曆 - full-screen "quiet" dashboard for the NAS machine's HDMI screen.
 * No popups, no sounds, nothing that steals focus. Events are one-off only.
 */

var API = window.WB.API;
var TOKEN_KEY = 'wb_nas_token';
var token = localStorage.getItem(TOKEN_KEY) || '';
var events = [];
var viewYear, viewMonth;          // month currently on screen
var authed = false;

var $ = function (id) { return document.getElementById(id); };

/* --------------------------------------------------------------- utilities */

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function todayStr() { return ymd(new Date()); }

var WEEK = ['日', '一', '二', '三', '四', '五', '六'];

/* ------------------------------------------------------------------ clock */

function tick() {
  var n = new Date();
  $('clock').innerHTML = pad(n.getHours()) + ':' + pad(n.getMinutes()) + '<small>' + pad(n.getSeconds()) + '</small>';
  $('dateline').innerHTML = '<b>' + n.getFullYear() + ' 年 ' + (n.getMonth() + 1) + ' 月 ' + n.getDate() +
    ' 日</b>　星期' + WEEK[n.getDay()];
}
setInterval(tick, 1000);
tick();

/* ---------------------------------------------------------------- weather */

var WMO = {
  0: '晴朗', 1: '大致晴朗', 2: '局部多雲', 3: '陰', 45: '有霧', 48: '霧凇',
  51: '細毛雨', 53: '毛雨', 55: '濃毛雨', 56: '凍毛雨', 57: '濃凍毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '凍雨', 67: '強凍雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '陣雨', 81: '中陣雨', 82: '強陣雨', 85: '陣雪', 86: '強陣雪',
  95: '雷暴', 96: '雷暴帶冰雹', 99: '強雷暴帶冰雹'
};
function wmo(c) { return WMO[c] || ('天氣代碼 ' + c); }

function loadWeather() {
  var L = window.WB.LOC;
  var u = 'https://api.open-meteo.com/v1/forecast?latitude=' + L.lat + '&longitude=' + L.lon +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min' +
    '&timezone=Asia%2FHong_Kong&forecast_days=4';

  fetch(u).then(function (r) { return r.json(); }).then(function (d) {
    var c = d.current;
    $('wtemp').textContent = Math.round(c.temperature_2m) + '°';
    $('wdesc').textContent = wmo(c.weather_code);
    $('wsub').textContent = '體感 ' + Math.round(c.apparent_temperature) + '° · 濕度 ' +
      c.relative_humidity_2m + '% · 風 ' + Math.round(c.wind_speed_10m) + ' km/h';

    var dd = d.daily, out = [];
    for (var i = 1; i < Math.min(4, dd.time.length); i++) {
      var dt = new Date(dd.time[i] + 'T00:00:00');
      out.push('<div>星期' + WEEK[dt.getDay()] + '　' + wmo(dd.weather_code[i]) + '　' +
        Math.round(dd.temperature_2m_min[i]) + '~' + Math.round(dd.temperature_2m_max[i]) + '°</div>');
    }
    $('wdays').innerHTML = out.join('');
    $('wbox').dataset.ok = '1';
  }).catch(function () {
    $('wdesc').textContent = '天氣暫時取不到';
    $('wsub').textContent = '（網絡或 API 問題，其餘照常顯示）';
  });
}
loadWeather();
setInterval(loadWeather, 20 * 60 * 1000);

/* ----------------------------------------------------------------- events */

function api(method, url, body) {
  return new Promise(function (resolve, reject) {
    var x = new XMLHttpRequest();
    x.open(method, API + url, true);
    if (token) x.setRequestHeader('Authorization', 'Bearer ' + token);
    if (body) x.setRequestHeader('Content-Type', 'application/json');
    x.onload = function () {
      var d = {};
      try { d = JSON.parse(x.responseText); } catch (e) { }
      if (x.status === 401) { authed = false; showAuth(); reject(new Error('unauthorized')); return; }
      if (x.status >= 200 && x.status < 300) { authed = true; resolve(d); }
      else reject(new Error(d.error || ('HTTP ' + x.status)));
    };
    x.onerror = function () { reject(new Error('offline')); };
    x.send(body ? JSON.stringify(body) : null);
  });
}

function showAuth() {
  $('authWarn').textContent = '要顯示／新增事項，請先到 ' + (API || '本機') +
    '/ 登入一次（同一部機只需登入一次，之後自動記住）。';
  $('todayList').innerHTML = '';
  $('upList').innerHTML = '';
  $('calNote').textContent = '未登入 · 只顯示日曆';
}

function loadEvents() {
  return api('GET', '/api/events').then(function (d) {
    events = d.events || [];
    $('authWarn').textContent = '';
    renderCal();
    renderSide();
  }).catch(function () { showAuth(); renderCal(); });
}

function byDate(s) {
  var m = {};
  events.forEach(function (e) { (m[e.date] = m[e.date] || []).push(e); });
  Object.keys(m).forEach(function (k) {
    m[k].sort(function (a, b) { return (a.time || '99:99').localeCompare(b.time || '99:99'); });
  });
  return m;
}

/* ------------------------------------------------------------------ render */

function renderCal() {
  var first = new Date(viewYear, viewMonth, 1);
  var startDow = first.getDay();
  var daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  var prevDays = new Date(viewYear, viewMonth, 0).getDate();

  $('monthTitle').textContent = viewYear + ' 年 ' + (viewMonth + 1) + ' 月';
  $('dow').innerHTML = WEEK.map(function (w) { return '<div>' + w + '</div>'; }).join('');

  var map = byDate();
  var grid = $('grid');
  grid.innerHTML = '';
  var t = todayStr();

  for (var i = 0; i < 42; i++) {
    var cell = document.createElement('div');
    cell.className = 'cell';
    var dayNum, dstr, other = false;

    if (i < startDow) { dayNum = prevDays - startDow + 1 + i; other = true; }
    else if (i >= startDow + daysInMonth) { dayNum = i - startDow - daysInMonth + 1; other = true; }
    else { dayNum = i - startDow + 1; }

    if (other) {
      var pm = viewMonth - 1, py = viewYear;
      if (pm < 0) { pm = 11; py--; }
      dstr = py + '-' + pad(pm + 1) + '-' + pad(dayNum);
      cell.className += ' other';
    } else {
      dstr = viewYear + '-' + pad(viewMonth + 1) + '-' + pad(dayNum);
    }

    if (dstr === t) cell.className += ' today';

    var d = document.createElement('div');
    d.className = 'd';
    d.textContent = dayNum;
    cell.appendChild(d);

    (map[dstr] || []).slice(0, 3).forEach(function (e) {
      var s = document.createElement('div');
      s.className = 'e';
      s.textContent = (e.time ? e.time + ' ' : '') + e.title;
      s.title = e.title + (e.note ? ' — ' + e.note : '');
      cell.appendChild(s);
    });
    if ((map[dstr] || []).length > 3) {
      var more = document.createElement('div');
      more.className = 'note';
      more.textContent = '+' + (map[dstr].length - 3);
      cell.appendChild(more);
    }
    grid.appendChild(cell);
  }
}

function evRow(e, showDate) {
  var row = document.createElement('div');
  row.className = 'ev';

  var t = document.createElement('div');
  t.className = 't';
  t.textContent = e.time || '全日';
  row.appendChild(t);

  var n = document.createElement('div');
  n.className = 'n';
  n.textContent = (showDate ? e.date.slice(5) + ' ' : '') + e.title;
  if (e.note) n.title = e.note;
  row.appendChild(n);

  var x = document.createElement('div');
  x.className = 'x';
  x.textContent = '✕';
  x.onclick = function () {
    api('POST', '/api/events', { action: 'delete', id: e.id }).then(function (d) {
      events = d.events; renderCal(); renderSide();
    }).catch(function () { });
  };
  row.appendChild(x);
  return row;
}

function renderSide() {
  var t = todayStr();
  var map = byDate();

  $('todayLabel').textContent = t.slice(5).replace('-', ' / ');

  var tl = $('todayList');
  tl.innerHTML = '';
  var todays = map[t] || [];
  if (!todays.length) {
    tl.innerHTML = '<div class="note">今天沒有事項</div>';
  } else {
    todays.forEach(function (e) { tl.appendChild(evRow(e, false)); });
  }

  var ul = $('upList');
  ul.innerHTML = '';
  var up = events.filter(function (e) { return e.date > t; })
    .sort(function (a, b) { return (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')); })
    .slice(0, 6);
  if (!up.length) {
    ul.innerHTML = '<div class="note">沒有即將到來的事項</div>';
  } else {
    up.forEach(function (e) { ul.appendChild(evRow(e, true)); });
  }
}

/* --------------------------------------------------------------------- add */

$('addBtn').onclick = function () {
  var date = $('nd').value || todayStr();
  var title = $('nn').value.trim();
  if (!title) { $('nn').focus(); return; }
  api('POST', '/api/events', { title: title, date: date, time: $('nt').value || '' })
    .then(function (d) {
      events = d.events;
      $('nn').value = '';
      // jump the grid to the month we just added to
      var dt = new Date(date + 'T00:00:00');
      viewYear = dt.getFullYear(); viewMonth = dt.getMonth();
      renderCal(); renderSide();
    })
    .catch(function () { });
};

$('nn').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('addBtn').click(); });

$('calNote').onclick = function () {
  var n = new Date();
  viewYear = n.getFullYear();
  viewMonth = n.getMonth();
  renderCal();
};

/* -------------------------------------------------------------------- boot */

function isLocalHost() {
  var h = location.hostname;
  return h === '127.0.0.1' || h === 'localhost' || h === '';
}

/* The wall screen must never stop and ask for a password - not after a reboot,
 * not after the server restarts. When the page is loaded straight from the NAS
 * itself, the server hands out a long-lived token to loopback callers only
 * (/api/local-token rejects anything arriving through Funnel with a 403). */
function grabLocalToken() {
  return fetch(API + '/api/local-token', { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (d) {
      if (!d || !d.token) throw new Error('no token');
      token = d.token;
      localStorage.setItem(TOKEN_KEY, token);
      return true;
    });
}

function start(allowLocalRetry) {
  api('GET', '/api/whoami').then(loadEvents).catch(function () {
    if (allowLocalRetry && isLocalHost()) {
      return grabLocalToken()
        .then(function () { return start(false); })
        .catch(function () { loadEvents(); });
    }
    loadEvents();
  });
}

var n0 = new Date();
viewYear = n0.getFullYear();
viewMonth = n0.getMonth();
$('nd').value = todayStr();

$('boot').remove();
$('root').classList.remove('hidden');
renderCal();
start(true);

/* Month auto-advances at midnight, and re-check events every 5 min so an entry
 * added from a phone shows up on the wall screen without anyone touching it. */
setInterval(loadEvents, 5 * 60 * 1000);
setInterval(function () {
  var n = new Date();
  if (n.getHours() === 0 && n.getMinutes() === 0) {
    viewYear = n.getFullYear(); viewMonth = n.getMonth();
    renderCal(); renderSide();
  }
}, 30000);
