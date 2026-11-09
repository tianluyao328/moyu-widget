/* Moyu widget — a quiet corner of the conversation.
 *
 * Client half: registers a seat in `conversation.session.header.utilities` and
 * portals the widget into the conversation body, so it only exists while a
 * Session with content is open. The resting face is a plausible subagent trace;
 * hovering swaps it for a live index ticker. Plain JavaScript; React comes from
 * the module table.
 */
window.__ModuleLoader__.load({
  id: '@local/moyu-widget',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const { useCallback, useEffect, useMemo, useRef, useState } = React;
    const h = React.createElement;

    const NS = 'moyu-widget';
    const STORAGE_KEY = 'dsh-moyu-widget.watchlist.v1';
    const QUOTES_URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get';
    const TENCENT_QUOTES_URL = 'https://qt.gtimg.cn/q=';
    const MINUTE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query';
    const MAX_ITEMS = 4;
    const REFRESH_MS = 20000;
    const TREND_MS = 60000;
    const QUOTE_FIELDS = 'f2,f3,f4,f12,f13,f14,f18';

    const DEFAULT_LIST = [
      { secid: '1.000001', name: '上证指数' },
      { secid: '0.399001', name: '深证成指' },
      { secid: '0.399006', name: '创业板指' },
      { secid: '1.000300', name: '沪深300' },
    ];

    /* ------------------------------------------------------------------ i18n */

    const DICT = {
      zh: {
        title: '摸鱼角',
        agent: '子代理运行中',
        tasks: '检索相关实现|核对改动差异|运行交互验证|汇总结果',
        queued: '排队中',
        parallel: '4 个任务',
        tokens: '{v}k tok/s',
        market: '大盘 · 自选',
        edit: '编辑自选',
        add: '添加',
        placeholder: '600519 或 sh600519',
        remove: '移除',
        invalid: '代码格式不对',
        missing: '没找到这只股票',
        full: '最多 4 个',
        loading: '拉取行情…',
        noTrend: '分时暂不可用',
        failed: '行情暂不可用',
        retry: '重试',
      },
      en: {
        title: 'Moyu corner',
        agent: 'Subagents running',
        tasks: 'Search implementations|Check the diff|Run interaction tests|Summarize findings',
        queued: 'queued',
        parallel: '4 tasks',
        tokens: '{v}k tok/s',
        market: 'Index · Watch',
        edit: 'Edit watchlist',
        add: 'Add',
        placeholder: '600519 or sh600519',
        remove: 'Remove',
        invalid: 'That code is not valid',
        missing: 'No such instrument',
        full: 'Four at most',
        loading: 'Loading quotes…',
        noTrend: 'No intraday line',
        failed: 'Quotes unavailable',
        retry: 'Retry',
      },
    };

    let translate = null;
    let lang = String((typeof navigator !== 'undefined' && navigator.language) || 'zh').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';

    function tr(key, vars) {
      let text = '';
      if (translate) {
        try {
          text = translate(key) || '';
        } catch (error) {
          text = '';
        }
      }
      if (!text || text === key) text = (DICT[lang] || DICT.zh)[key] || DICT.zh[key] || key;
      if (vars) {
        for (const name of Object.keys(vars)) text = text.split('{' + name + '}').join(String(vars[name]));
      }
      return text;
    }

    function makeTranslate(locale) {
      if (!locale) return null;
      let bound = null;
      try {
        bound = locale.bind(NS);
      } catch (error) {
        bound = null;
      }
      return (key) => {
        if (bound) {
          try {
            const value = bound(key);
            if (value && value !== key) return value;
          } catch (error) {
            /* fall through to the local dictionary */
          }
        }
        try {
          const active = String((locale.getLocale && locale.getLocale().active) || '').toLowerCase();
          const dict = DICT[active.split('-')[0]] || DICT.en;
          return dict[key] || DICT.en[key] || key;
        } catch (error) {
          return key;
        }
      };
    }

    /* ----------------------------------------------------------------- utils */

    const PRICE_FMT = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const CLOCK_FMT = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const WEEKDAY_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' });
    const HM_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });

    function number(value) {
      const parsed = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    function money(value) {
      return value === null || value === undefined ? '—' : PRICE_FMT.format(value);
    }

    function signed(value, digits) {
      if (value === null || value === undefined || !Number.isFinite(value)) return '—';
      return (value > 0 ? '+' : '') + value.toFixed(digits === undefined ? 2 : digits);
    }

    function pctText(value) {
      return value === null || value === undefined || !Number.isFinite(value) ? '—' : signed(value) + '%';
    }

    function dirOf(value) {
      if (value === null || value === undefined || !Number.isFinite(value)) return 'flat';
      if (value > 0.0001) return 'up';
      if (value < -0.0001) return 'down';
      return 'flat';
    }

    function duration(seconds) {
      const minutes = Math.floor(seconds / 60);
      if (!minutes) return seconds + 's';
      return minutes + 'm' + String(seconds % 60).padStart(2, '0');
    }

    function thin(points, limit) {
      if (!points || points.length <= limit) return points;
      const step = points.length / limit;
      const out = [];
      for (let index = 0; index < limit; index += 1) out.push(points[Math.floor(index * step)]);
      out[out.length - 1] = points[points.length - 1];
      return out;
    }

    function clockText(date) {
      try {
        return CLOCK_FMT.format(date);
      } catch (error) {
        return '--:--:--';
      }
    }

    function marketOpen(date) {
      try {
        const weekday = WEEKDAY_FMT.format(date).slice(0, 3);
        if (weekday === 'Sat' || weekday === 'Sun') return false;
        const parts = HM_FMT.format(date).split(':');
        const minutes = Number(parts[0]) * 60 + Number(parts[1]);
        return (minutes >= 570 && minutes <= 690) || (minutes >= 780 && minutes <= 900);
      } catch (error) {
        return false;
      }
    }

    function minuteLabel(stamp) {
      const text = String(stamp || '');
      if (text.length < 4) return text;
      return text.slice(0, 2) + ':' + text.slice(2, 4);
    }

    function normalizeSecid(raw) {
      const text = String(raw || '').trim().toLowerCase();
      if (!text) return null;
      if (/^[01]\.[0-9]{6}$/.test(text)) return text;
      if (/^(sh|sz)[0-9]{6}$/.test(text)) return (text.slice(0, 2) === 'sh' ? '1.' : '0.') + text.slice(2);
      if (/^[0-9]{6}$/.test(text)) {
        const head = text.charAt(0);
        if (head === '6' || head === '5' || head === '9') return '1.' + text;
        if (head === '0' || head === '1' || head === '2' || head === '3') return '0.' + text;
      }
      return null;
    }

    /* --------------------------------------------------------------- storage */

    function loadList() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            const items = parsed
              .filter((item) => item && typeof item.secid === 'string' && /^[01]\.[0-9]{6}$/.test(item.secid))
              .slice(0, MAX_ITEMS)
              .map((item) => ({ secid: item.secid, name: typeof item.name === 'string' ? item.name : '' }));
            if (items.length) return items;
          }
        }
      } catch (error) {
        /* first run, or storage blocked by the browser */
      }
      return DEFAULT_LIST.map((item) => ({ secid: item.secid, name: item.name }));
    }

    function saveList(items) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
      } catch (error) {
        /* a blocked storage only costs the saved watchlist */
      }
    }

    /* ------------------------------------------------------------------ data */

    function deadline(signal, ms) {
      try {
        if (AbortSignal && AbortSignal.timeout) {
          const timeout = AbortSignal.timeout(ms);
          if (!signal) return timeout;
          if (AbortSignal.any) return AbortSignal.any([signal, timeout]);
        }
      } catch (error) {
        /* older browser: rely on the caller's signal */
      }
      return signal;
    }

    async function readJSON(url, signal) {
      const response = await fetch(url, { signal, credentials: 'omit', cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    }

    async function fetchEastmoneyQuotes(secids, signal) {
      const query = new URLSearchParams({
        fltt: '2',
        invt: '2',
        fields: QUOTE_FIELDS,
        secids: secids.join(','),
        _: String(Date.now()),
      });
      const json = await readJSON(QUOTES_URL + '?' + query.toString(), deadline(signal, 8000));
      const diff = json && json.data ? json.data.diff : null;
      const rows = Array.isArray(diff) ? diff : diff && typeof diff === 'object' ? Object.values(diff) : [];
      const out = {};
      for (const row of rows) {
        if (!row || row.f12 === undefined || row.f13 === undefined) continue;
        const secid = String(row.f13) + '.' + String(row.f12);
        out[secid] = {
          secid,
          name: typeof row.f14 === 'string' ? row.f14 : '',
          price: number(row.f2),
          pct: number(row.f3),
          chg: number(row.f4),
          prev: number(row.f18),
        };
      }
      return out;
    }

    async function fetchTencentQuotes(secids, signal) {
      const codes = secids.map(minuteCode).join(',');
      const response = await fetch(TENCENT_QUOTES_URL + codes + '&_=' + Date.now(), {
        signal: deadline(signal, 8000),
        credentials: 'omit',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const buffer = await response.arrayBuffer();
      let text = '';
      try {
        text = new TextDecoder('gbk').decode(buffer);
      } catch (error) {
        text = new TextDecoder('utf-8').decode(buffer);
      }
      const out = {};
      const pattern = /v_([a-z]{2}[0-9]{6})="([^"]*)"/g;
      let match = pattern.exec(text);
      while (match) {
        const fields = match[2].split('~');
        if (fields.length > 32) {
          const secid = (match[1].slice(0, 2) === 'sh' ? '1.' : '0.') + match[1].slice(2);
          out[secid] = {
            secid,
            name: fields[1] || '',
            price: number(fields[3]),
            prev: number(fields[4]),
            chg: number(fields[31]),
            pct: number(fields[32]),
          };
        }
        match = pattern.exec(text);
      }
      if (!Object.keys(out).length) throw new Error('empty quote payload');
      return out;
    }

    async function fetchQuotes(secids, signal) {
      try {
        const primary = await fetchEastmoneyQuotes(secids, signal);
        if (Object.keys(primary).length) return primary;
      } catch (error) {
        /* the mirror below keeps a flaky vendor from emptying the widget */
      }
      return fetchTencentQuotes(secids, signal);
    }

    function minuteCode(secid) {
      return (secid.charAt(0) === '1' ? 'sh' : 'sz') + secid.slice(2);
    }

    async function fetchTrend(secid, signal) {
      const code = minuteCode(secid);
      const json = await readJSON(MINUTE_URL + '?code=' + code + '&_=' + Date.now(), deadline(signal, 8000));
      const node = json && json.data ? json.data[code] : null;
      const raw = node && node.data ? node.data.data : null;
      if (!Array.isArray(raw)) return null;
      const points = [];
      for (const line of raw) {
        const parts = String(line).split(' ');
        const price = number(parts[1]);
        if (parts[0] && price !== null) points.push({ time: parts[0], price });
      }
      return points.length ? points : null;
    }

    /* ----------------------------------------------------------------- hooks */

    function useTicker() {
      const [tick, setTick] = useState(0);
      useEffect(() => {
        const id = window.setInterval(() => setTick((value) => value + 1), 1000);
        return () => window.clearInterval(id);
      }, []);
      return tick;
    }

    function useMarket(secids, active) {
      const key = secids.join(',');
      const [snap, setSnap] = useState({ status: 'idle', quotes: {}, trends: {}, at: 0, error: '' });
      const seq = useRef(0);
      const controller = useRef(null);
      const trendAt = useRef(0);
      const trendKey = useRef('');

      const load = useCallback(
        async (initial) => {
          const mine = ++seq.current;
          if (controller.current) controller.current.abort();
          const live = new AbortController();
          controller.current = live;
          if (initial) setSnap((state) => (state.at ? state : Object.assign({}, state, { status: 'loading', error: '' })));
          try {
            const quotes = await fetchQuotes(secids, live.signal);
            if (mine !== seq.current) return;
            setSnap((state) => Object.assign({}, state, { status: 'ready', quotes: Object.assign({}, state.quotes, quotes), at: Date.now(), error: '' }));
            const now = Date.now();
            if (trendKey.current !== key || now - trendAt.current > TREND_MS) {
              trendKey.current = key;
              trendAt.current = now;
              const results = await Promise.allSettled(secids.map((secid) => fetchTrend(secid, live.signal)));
              if (mine !== seq.current) return;
              const trends = {};
              results.forEach((result, index) => {
                if (result.status === 'fulfilled' && result.value) trends[secids[index]] = result.value;
              });
              if (Object.keys(trends).length) setSnap((state) => Object.assign({}, state, { trends: Object.assign({}, state.trends, trends) }));
            }
          } catch (error) {
            if (mine !== seq.current) return;
            if (error && error.name === 'AbortError') return;
            setSnap((state) => Object.assign({}, state, { status: state.at ? state.status : 'error', error: 'failed' }));
          }
        },
        [key],
      );

      useEffect(() => {
        if (!active) {
          if (controller.current) controller.current.abort();
          return undefined;
        }
        load(true);
        const id = window.setInterval(() => load(false), REFRESH_MS);
        return () => {
          window.clearInterval(id);
          if (controller.current) controller.current.abort();
        };
      }, [active, load]);

      const reload = useCallback(() => load(true), [load]);
      return [snap, reload];
    }

    /* ----------------------------------------------------------------- icons */

    function Icon(props) {
      return h(
        'svg',
        {
          width: props.size || 12,
          height: props.size || 12,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        props.children,
      );
    }

    function PencilIcon() {
      return h(
        Icon,
        null,
        h('path', { d: 'M3.2 12.8l.5-2.3 6-6a1.35 1.35 0 0 1 1.9 1.9l-6 6-2.4.4z' }),
        h('path', { d: 'M8.9 5.2l1.9 1.9' }),
      );
    }

    function CheckIcon() {
      return h(Icon, { size: 10 }, h('path', { d: 'M3.4 8.4l3 3 6.2-6.8', strokeWidth: 1.7 }));
    }

    function CloseIcon() {
      return h(Icon, { size: 9 }, h('path', { d: 'M4 4l8 8M12 4l-8 8', strokeWidth: 1.5 }));
    }

    /* ------------------------------------------------------------- sparkline */

    let sparkSeq = 0;

    function shape(points, prev, width, height) {
      if (!points || points.length < 2) return null;
      const values = points.map((point) => point.price);
      let min = Math.min.apply(null, values);
      let max = Math.max.apply(null, values);
      const base = prev !== null && prev !== undefined && prev > 0 ? prev : values[0];
      if (prev > 0) {
        min = Math.min(min, prev);
        max = Math.max(max, prev);
      }
      if (!(max > min)) max = min + Math.max(Math.abs(min) * 0.001, 0.01);
      const pad = (max - min) * 0.12 || 0.2;
      min -= pad;
      max += pad;
      const innerW = width - 2;
      const innerH = height - 2;
      const x = (index) => 1 + (index / (points.length - 1)) * innerW;
      const y = (value) => 1 + (1 - (value - min) / (max - min)) * innerH;

      let up = '';
      let down = '';
      for (let index = 1; index < points.length; index += 1) {
        const before = points[index - 1];
        const after = points[index];
        const segment = 'M' + x(index - 1).toFixed(2) + ' ' + y(before.price).toFixed(2) + 'L' + x(index).toFixed(2) + ' ' + y(after.price).toFixed(2);
        if (after.price >= base) up += segment;
        else down += segment;
      }

      let area = 'M' + x(0).toFixed(2) + ' ' + height;
      for (let index = 0; index < points.length; index += 1) {
        area += 'L' + x(index).toFixed(2) + ' ' + y(points[index].price).toFixed(2);
      }
      area += 'L' + x(points.length - 1).toFixed(2) + ' ' + height + 'Z';

      const last = points[points.length - 1];
      return {
        up,
        down,
        area,
        prevY: prev > 0 ? y(prev) : null,
        lastX: x(points.length - 1),
        lastY: y(last.price),
        dir: last.price >= base ? 'up' : 'down',
      };
    }

    function Sparkline(props) {
      const idRef = useRef(null);
      if (!idRef.current) {
        sparkSeq += 1;
        idRef.current = NS + '-g' + sparkSeq;
      }
      const geom = useMemo(() => {
        const samples = thin(props.points, props.width > 100 ? 120 : 40);
        return shape(samples, props.prev, props.width, props.height);
      }, [props.points, props.prev, props.width, props.height]);
      if (!geom) return null;
      const color = geom.dir === 'up' ? 'var(--mw-up)' : 'var(--mw-down)';
      return h(
        'svg',
        {
          width: props.width,
          height: props.height,
          viewBox: '0 0 ' + props.width + ' ' + props.height,
          className: 'mw-spark',
          'aria-hidden': 'true',
        },
        h(
          'defs',
          null,
          h(
            'linearGradient',
            { id: idRef.current, x1: '0', y1: '0', x2: '0', y2: '1' },
            h('stop', { offset: '0%', stopColor: color, stopOpacity: 0.24 }),
            h('stop', { offset: '100%', stopColor: color, stopOpacity: 0 }),
          ),
        ),
        props.withArea ? h('path', { d: geom.area, fill: 'url(#' + idRef.current + ')' }) : null,
        props.withPrev && geom.prevY !== null
          ? h('line', { x1: 0, x2: props.width, y1: geom.prevY, y2: geom.prevY, className: 'mw-prev' })
          : null,
        geom.down ? h('path', { d: geom.down, className: 'mw-stroke mw-down-stroke' }) : null,
        geom.up ? h('path', { d: geom.up, className: 'mw-stroke mw-up-stroke' }) : null,
        props.withDot ? h('circle', { cx: geom.lastX, cy: geom.lastY, r: 1.7, className: 'mw-last-' + geom.dir }) : null,
      );
    }

    /* ------------------------------------------------------------------ idle */

    function IdleFace(props) {
      const tick = props.tick;
      const tasks = tr('tasks').split('|');
      const rate = (2.0 + ((tick * 7) % 19) / 10).toFixed(1);
      return h(
        'div',
        { className: 'mw-face mw-idle' },
        h(
          'div',
          { className: 'mw-status' },
          h('span', { className: 'mw-dot' }),
          h(
            'span',
            { className: 'mw-status-title' },
            tr('agent'),
            h('span', { className: 'mw-ellipsis' }, h('i'), h('i'), h('i')),
          ),
          h('span', { className: 'mw-status-meta' }, '#4f2c'),
        ),
        h(
          'div',
          { className: 'mw-tasks' },
          tasks.map((label, index) => {
            const queued = index === tasks.length - 1;
            const cycle = (tick + index * 9) % 20;
            const done = !queued && cycle >= 17.5;
            const seconds = 11 + tick + index * 3;
            return h(
              'div',
              { className: 'mw-task', key: label },
              queued
                ? h('span', { className: 'mw-wait' })
                : done
                  ? h('span', { className: 'mw-check' }, h(CheckIcon))
                  : h('span', { className: 'mw-spin', style: { animationDelay: index * -0.23 + 's' } }),
              h('span', { className: 'mw-task-label' }, label),
              h('span', { className: 'mw-task-time' }, queued ? tr('queued') : duration(seconds)),
            );
          }),
        ),
        h(
          'div',
          { className: 'mw-foot' },
          h('span', { className: 'mw-brand' }, 'dsh'),
          h('span', { className: 'mw-sep' }, '·'),
          h('span', null, tr('parallel')),
          h('span', { className: 'mw-foot-rate' }, tr('tokens', { v: rate })),
        ),
      );
    }

    /* ---------------------------------------------------------------- market */

    function MarketFace(props) {
      const list = props.list;
      const quotes = props.quotes;
      const trends = props.trends;
      const featured = list[0];
      const quote = featured ? quotes[featured.secid] : null;
      const trend = featured ? trends[featured.secid] : null;
      const dir = dirOf(quote ? quote.pct : null);
      const rows = list.slice(1, 4).map((item) => {
        const rowQuote = quotes[item.secid];
        const rowTrend = trends[item.secid];
        return { item, quote: rowQuote, trend: rowTrend };
      });

      return h(
        'div',
        { className: 'mw-face mw-market' },
        h(
          'div',
          { className: 'mw-mhead' },
          h('span', { className: 'mw-live', 'data-open': marketOpen(new Date()) ? 'true' : 'false' }),
          h('span', { className: 'mw-mtitle' }, tr('market')),
          h('span', { className: 'mw-clock' }, clockText(new Date())),
          h(
            'button',
            {
              type: 'button',
              className: 'mw-editbtn',
              title: tr('edit'),
              'aria-label': tr('edit'),
              onClick: props.onEdit,
            },
            h(PencilIcon),
          ),
        ),
        h(
          'div',
          { className: 'mw-main' },
          h(
            'div',
            { className: 'mw-main-top' },
            h('span', { className: 'mw-main-name' }, (quote && quote.name) || (featured && featured.name) || '—'),
            h('span', { className: 'mw-main-code' }, featured ? featured.secid.slice(2) : ''),
          ),
          h(
            'div',
            { className: 'mw-price-row' },
            h('span', { className: 'mw-price mw-' + dir }, money(quote ? quote.price : null)),
            h('span', { className: 'mw-chg' }, quote && quote.chg !== null ? signed(quote.chg) : ''),
            h('span', { className: 'mw-pct mw-' + dir }, pctText(quote ? quote.pct : null)),
          ),
          h(
            'div',
            { className: 'mw-chart' },
            trend && trend.length > 1
              ? h(
                  React.Fragment,
                  null,
                  h(Sparkline, {
                    points: trend,
                    prev: quote ? quote.prev : null,
                    width: 184,
                    height: 38,
                    withArea: true,
                    withPrev: true,
                    withDot: true,
                  }),
                  h(
                    'div',
                    { className: 'mw-axis' },
                    h('span', null, minuteLabel(trend[0].time)),
                    h('span', null, minuteLabel(trend[trend.length - 1].time)),
                  ),
                )
              : h(
                  'div',
                  { className: 'mw-chart-empty' },
                  props.status === 'error'
                    ? h('button', { type: 'button', className: 'mw-retry', onClick: props.onRetry }, tr('failed') + ' · ' + tr('retry'))
                    : props.status === 'ready'
                      ? tr('noTrend')
                      : tr('loading'),
                ),
          ),
        ),
        h(
          'div',
          { className: 'mw-list' },
          rows.map((row) => {
            const rowDir = dirOf(row.quote ? row.quote.pct : null);
            return h(
              'div',
              { className: 'mw-row', key: row.item.secid },
              h('span', { className: 'mw-row-name' }, (row.quote && row.quote.name) || row.item.name || row.item.secid),
              h(
                'span',
                { className: 'mw-row-spark' },
                row.trend && row.trend.length > 1
                  ? h(Sparkline, {
                      points: row.trend,
                      prev: row.quote ? row.quote.prev : null,
                      width: 38,
                      height: 12,
                      withArea: false,
                      withPrev: false,
                      withDot: false,
                    })
                  : null,
              ),
              h('span', { className: 'mw-row-price' }, money(row.quote ? row.quote.price : null)),
              h('span', { className: 'mw-row-pct mw-' + rowDir }, pctText(row.quote ? row.quote.pct : null)),
            );
          }),
        ),
      );
    }

    /* ---------------------------------------------------------------- editor */

    function Editor(props) {
      const [text, setText] = useState('');
      const [note, setNote] = useState('');
      const [busy, setBusy] = useState(false);

      const submit = (event) => {
        event.preventDefault();
        if (busy) return;
        const raw = text;
        if (!raw.trim()) return;
        setBusy(true);
        setNote('');
        Promise.resolve(props.onAdd(raw))
          .then((result) => {
            if (result && result.error) setNote(result.error);
            else setText('');
          })
          .catch(() => setNote(tr('failed')))
          .then(() => setBusy(false));
      };

      return h(
        'div',
        { className: 'mw-editor', onPointerDown: (event) => event.stopPropagation() },
        h(
          'form',
          { onSubmit: submit },
          h('input', {
            value: text,
            onChange: (event) => setText(event.target.value),
            placeholder: tr('placeholder'),
            'aria-label': tr('placeholder'),
            spellCheck: false,
            autoFocus: true,
          }),
          h('button', { type: 'submit', className: 'mw-add', disabled: busy }, tr('add')),
        ),
        h('div', { className: 'mw-note' }, note || ''),
        h(
          'ul',
          null,
          props.items.map((item) =>
            h(
              'li',
              { key: item.secid },
              h('span', { className: 'mw-item-name' }, item.name || item.secid),
              h('span', { className: 'mw-item-code' }, item.secid.slice(2)),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mw-remove',
                  title: tr('remove'),
                  'aria-label': tr('remove'),
                  onClick: () => props.onRemove(item.secid),
                  disabled: props.items.length <= 1,
                },
                h(CloseIcon),
              ),
            ),
          ),
        ),
      );
    }

    /* ---------------------------------------------------------------- widget */

    function Widget(props) {
      const frame = props.frame;
      const [list, setList] = useState(loadList);
      const [hot, setHot] = useState(false);
      const [editing, setEditing] = useState(false);
      const rootRef = useRef(null);
      const tick = useTicker();
      const active = hot || editing;
      const secids = useMemo(() => list.map((item) => item.secid), [list]);
      const [market, reload] = useMarket(secids, active);
      const tight = frame.width > 0 && frame.width < 880;

      useEffect(() => {
        saveList(list);
      }, [list]);

      useEffect(() => {
        if (!editing) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') {
            setEditing(false);
            setHot(false);
          }
        };
        const onDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) {
            setEditing(false);
            setHot(false);
          }
        };
        window.addEventListener('keydown', onKey, true);
        document.addEventListener('pointerdown', onDown, true);
        return () => {
          window.removeEventListener('keydown', onKey, true);
          document.removeEventListener('pointerdown', onDown, true);
        };
      }, [editing]);

      const add = useCallback(
        async (raw) => {
          const secid = normalizeSecid(raw);
          if (!secid) return { error: tr('invalid') };
          if (list.some((item) => item.secid === secid)) return { ok: true };
          if (list.length >= MAX_ITEMS) return { error: tr('full') };
          try {
            const found = await fetchQuotes([secid]);
            const quote = found[secid];
            if (!quote || quote.price === null) return { error: tr('missing') };
            setList((current) =>
              current.some((item) => item.secid === secid) || current.length >= MAX_ITEMS
                ? current
                : current.concat({ secid, name: quote.name || secid }),
            );
            return { ok: true };
          } catch (error) {
            return { error: tr('failed') };
          }
        },
        [list],
      );

      const remove = useCallback((secid) => {
        setList((current) => (current.length <= 1 ? current : current.filter((item) => item.secid !== secid)));
      }, []);

      return h(
        'div',
        {
          ref: rootRef,
          className: 'mw-root',
          style: { left: frame.left + 'px', top: frame.top + 'px' },
          'data-hot': hot ? 'true' : 'false',
          'data-tight': tight ? 'true' : 'false',
          role: 'complementary',
          'aria-label': tr('title'),
          tabIndex: 0,
          onPointerEnter: () => setHot(true),
          onPointerLeave: () => {
            if (!editing) setHot(false);
          },
          onFocus: () => setHot(true),
          onBlur: (event) => {
            if (editing) return;
            if (!rootRef.current || !rootRef.current.contains(event.relatedTarget)) setHot(false);
          },
        },
        h(IdleFace, { tick }),
        h(MarketFace, {
          list,
          quotes: market.quotes,
          trends: market.trends,
          status: market.status,
          error: market.error,
          tick,
          onRetry: reload,
          onEdit: () => {
            setHot(true);
            setEditing((value) => !value);
          },
        }),
        editing ? h(Editor, { items: list, onAdd: add, onRemove: remove }) : null,
      );
    }

    /* ------------------------------------------------------------------ seat */

    function Corner() {
      const anchorRef = useRef(null);
      const [frame, setFrame] = useState(null);

      useEffect(() => {
        const anchor = anchorRef.current;
        if (!anchor) return undefined;
        const header = anchor.closest('header');
        if (!header) return undefined;
        const root = header.closest('[data-phase]');
        let resizeObserver = null;
        let phaseObserver = null;
        let pending = 0;

        const measure = () => {
          pending = 0;
          const rect = header.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          const phase = root ? root.getAttribute('data-phase') : null;
          const width = 208;
          const right = Math.min(window.innerWidth - 8, rect.right - 10);
          setFrame({
            left: Math.max(8, Math.round(right - width)),
            top: Math.round(rect.bottom + 10),
            width: Math.round(rect.width),
            hero: phase === 'hero',
          });
        };
        const schedule = () => {
          if (pending) return;
          pending = window.requestAnimationFrame(measure);
        };

        measure();
        if (typeof ResizeObserver === 'function') {
          resizeObserver = new ResizeObserver(schedule);
          resizeObserver.observe(header);
        }
        window.addEventListener('resize', schedule);
        if (root && typeof MutationObserver === 'function') {
          phaseObserver = new MutationObserver(schedule);
          phaseObserver.observe(root, { attributes: true, attributeFilter: ['data-phase'] });
        }
        return () => {
          if (pending) window.cancelAnimationFrame(pending);
          if (resizeObserver) resizeObserver.disconnect();
          if (phaseObserver) phaseObserver.disconnect();
          window.removeEventListener('resize', schedule);
        };
      }, []);

      return h(
        React.Fragment,
        null,
        h('span', { ref: anchorRef, className: 'mw-anchor', 'aria-hidden': 'true' }),
        frame && !frame.hero ? ReactDOM.createPortal(h(Widget, { frame }), window.document.body) : null,
      );
    }

    /** The seat only anchors the widget; the conversation's own `data-phase` decides whether it shows. */
    function MoyuSeat() {
      return h(Corner, null);
    }

    /* ------------------------------------------------------------------- css */

    const CSS = `
.mw-anchor{display:none}
.mw-root{
  position:fixed;left:0;top:0;width:208px;height:196px;z-index:30;box-sizing:border-box;
  border-radius:14px;isolation:isolate;outline:none;
  --mw-up:#d0453f;--mw-down:#128a5b;--mw-flat:#8b919b;--mw-ok:#2f9e6a;
  --mw-text:var(--dsw-alias-label-primary,#1b1b1b);
  --mw-text-2:var(--dsw-alias-label-secondary,#4b4b4b);
  --mw-text-3:var(--dsw-alias-label-tertiary,#6f6f6f);
  --mw-caption:var(--dsw-alias-label-caption,#9a9a9a);
  --mw-line:var(--dsw-alias-border-l1,rgba(15,18,25,.08));
  --mw-line-2:var(--dsw-alias-border-l3,rgba(15,18,25,.14));
  --mw-bg:var(--dsw-alias-bg-base,#fff);
  --mw-accent:var(--dsw-alias-state-business-primary,#4176e6);
  border:1px solid color-mix(in srgb,var(--mw-line-2) 84%,transparent);
  background:color-mix(in srgb,var(--mw-bg) 97%,transparent);
  -webkit-backdrop-filter:blur(18px) saturate(1.35);backdrop-filter:blur(18px) saturate(1.35);
  box-shadow:0 14px 34px -24px rgba(12,16,24,.42),0 1px 2px rgba(12,16,24,.04);
  color:var(--mw-text);font-size:12px;line-height:1.4;letter-spacing:.01em;
  -webkit-user-select:none;user-select:none;
  transition:box-shadow .2s ease,border-color .2s ease;
}
.mw-root:focus-visible{border-color:color-mix(in srgb,var(--mw-accent) 45%,transparent);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--mw-accent) 16%,transparent),0 18px 40px -26px rgba(12,16,24,.5)}
.mw-root[data-hot="true"]{box-shadow:0 20px 42px -22px rgba(12,16,24,.5),0 1px 2px rgba(12,16,24,.05)}
.mw-root[data-tight="true"]{display:none}
body[data-ds-dark-theme] .mw-root{
  --mw-up:#ff6b63;--mw-down:#3fce8d;--mw-flat:#9aa1ab;--mw-ok:#4ecf92;
  box-shadow:0 22px 46px -26px rgba(0,0,0,.85);
}
.mw-face{position:absolute;inset:0;box-sizing:border-box;padding:12px;display:flex;flex-direction:column;
  transition:opacity .16s ease,transform .24s cubic-bezier(.2,.7,.3,1)}
.mw-idle{opacity:1;transform:none}
.mw-market{opacity:0;transform:translateY(4px);pointer-events:none}
.mw-root[data-hot="true"] .mw-idle{opacity:0;transform:scale(.982);pointer-events:none}
.mw-root[data-hot="true"] .mw-market{opacity:1;transform:none;pointer-events:auto}
.mw-status{display:flex;align-items:center;gap:7px;height:16px;flex:none;min-width:0}
.mw-dot{width:6px;height:6px;flex:none;border-radius:50%;background:var(--mw-accent);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--mw-accent) 13%,transparent);animation:mw-pulse 2.6s ease-in-out infinite}
@keyframes mw-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.82)}}
.mw-status-title{display:inline-flex;align-items:center;font-size:11.5px;font-weight:500;color:var(--mw-text);white-space:nowrap}
.mw-status-meta{margin-left:auto;font-size:9.5px;color:var(--mw-caption);font-variant-numeric:tabular-nums;letter-spacing:.03em}
.mw-ellipsis{display:inline-flex;gap:2px;margin-left:3px;transform:translateY(1px)}
.mw-ellipsis i{width:2px;height:2px;border-radius:50%;background:var(--mw-caption);opacity:.3;animation:mw-blink 1.4s infinite}
.mw-ellipsis i:nth-child(2){animation-delay:.18s}
.mw-ellipsis i:nth-child(3){animation-delay:.36s}
@keyframes mw-blink{0%,60%,100%{opacity:.22}30%{opacity:.9}}
.mw-tasks{margin-top:8px;display:flex;flex-direction:column;flex:none}
.mw-task{display:flex;align-items:center;gap:7px;height:26px;min-width:0;font-size:11.5px;color:var(--mw-text-2)}
.mw-task-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mw-task-time{font-size:9.5px;color:var(--mw-caption);font-variant-numeric:tabular-nums;white-space:nowrap}
.mw-spin{width:9px;height:9px;flex:none;border-radius:50%;border:1.5px solid color-mix(in srgb,var(--mw-accent) 22%,transparent);
  border-top-color:var(--mw-accent);animation:mw-spin 1.15s linear infinite}
@keyframes mw-spin{to{transform:rotate(360deg)}}
.mw-wait{width:8px;height:8px;margin-left:.5px;flex:none;border-radius:50%;
  border:1.4px dashed color-mix(in srgb,var(--mw-text-3) 40%,transparent)}
.mw-check{width:9px;flex:none;display:flex;justify-content:center;color:var(--mw-ok)}
.mw-foot{margin-top:auto;padding-top:8px;border-top:1px solid var(--mw-line);display:flex;align-items:center;gap:5px;
  font-size:9.5px;color:var(--mw-caption);white-space:nowrap}
.mw-brand{font-weight:600;letter-spacing:.04em;color:var(--mw-text-3)}
.mw-sep{opacity:.5}
.mw-foot-rate{margin-left:auto;font-variant-numeric:tabular-nums}
.mw-mhead{display:flex;align-items:center;gap:6px;height:16px;flex:none;min-width:0}
.mw-live{width:5px;height:5px;flex:none;border-radius:50%;background:var(--mw-up);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--mw-up) 12%,transparent);animation:mw-pulse 2.4s infinite}
.mw-live[data-open="false"]{background:var(--mw-caption);box-shadow:none;animation:none}
.mw-mtitle{font-size:10.5px;color:var(--mw-text-3);letter-spacing:.03em}
.mw-clock{margin-left:auto;font-size:9.5px;color:var(--mw-caption);font-variant-numeric:tabular-nums}
.mw-editbtn{width:18px;height:18px;flex:none;margin-right:-3px;padding:0;display:grid;place-items:center;border:0;border-radius:5px;
  background:transparent;color:var(--mw-caption);cursor:pointer;font:inherit}
.mw-editbtn:hover{background:color-mix(in srgb,var(--mw-text) 8%,transparent);color:var(--mw-text-2)}
.mw-main{margin-top:5px;flex:none}
.mw-main-top{display:flex;align-items:baseline;gap:6px;min-width:0}
.mw-main-name{font-size:11px;color:var(--mw-text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mw-main-code{font-size:8.5px;color:var(--mw-caption);letter-spacing:.08em;font-variant-numeric:tabular-nums}
.mw-price-row{display:flex;align-items:baseline;gap:6px;margin-top:1px;min-width:0}
.mw-price{font-size:19px;font-weight:600;line-height:1.1;letter-spacing:-.015em;font-variant-numeric:tabular-nums}
.mw-chg{font-size:9.5px;color:var(--mw-text-3);font-variant-numeric:tabular-nums}
.mw-pct{margin-left:auto;font-size:10px;font-weight:600;line-height:16px;padding:0 5px;border-radius:5px;font-variant-numeric:tabular-nums}
.mw-pct.mw-up{color:var(--mw-up);background:color-mix(in srgb,var(--mw-up) 10%,transparent)}
.mw-pct.mw-down{color:var(--mw-down);background:color-mix(in srgb,var(--mw-down) 10%,transparent)}
.mw-pct.mw-flat{color:var(--mw-flat);background:color-mix(in srgb,var(--mw-flat) 10%,transparent)}
.mw-up{color:var(--mw-up)}
.mw-down{color:var(--mw-down)}
.mw-flat{color:var(--mw-flat)}
.mw-chart{margin-top:4px;height:48px;flex:none;position:relative}
.mw-chart svg{display:block;width:100%;height:38px}
.mw-axis{display:flex;justify-content:space-between;padding:1px 1px 0;font-size:8.5px;color:var(--mw-caption);
  font-variant-numeric:tabular-nums;letter-spacing:.02em}
.mw-retry{padding:0;border:0;background:transparent;color:var(--mw-caption);font:inherit;font-size:9.5px;cursor:pointer}
.mw-retry:hover{color:var(--mw-text-2);text-decoration:underline}
.mw-chart-empty{height:38px;display:grid;place-items:center;font-size:9.5px;color:var(--mw-caption);
  border-top:1px dashed color-mix(in srgb,var(--mw-line) 70%,transparent);
  border-bottom:1px dashed color-mix(in srgb,var(--mw-line) 70%,transparent)}
.mw-prev{stroke:color-mix(in srgb,var(--mw-text-3) 32%,transparent);stroke-width:1;stroke-dasharray:2 3}
.mw-stroke{fill:none;stroke-width:1.15;stroke-linejoin:round;stroke-linecap:round}
.mw-up-stroke{stroke:var(--mw-up)}
.mw-down-stroke{stroke:var(--mw-down)}
.mw-last-up{fill:var(--mw-up)}
.mw-last-down{fill:var(--mw-down)}
.mw-last-flat{fill:var(--mw-flat)}
.mw-list{margin-top:5px;display:flex;flex-direction:column;flex:none}
.mw-row{display:flex;align-items:center;gap:4px;height:19px;min-width:0;font-size:10px}
.mw-row-name{width:42px;flex:none;color:var(--mw-text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mw-row-spark{width:38px;flex:none;height:12px;display:flex;align-items:center;overflow:hidden}
.mw-row-spark svg{display:block}
.mw-row-price{flex:1;min-width:0;text-align:right;color:var(--mw-text-3);font-variant-numeric:tabular-nums;font-size:9.5px;white-space:nowrap}
.mw-row-pct{width:42px;flex:none;text-align:right;font-weight:500;font-variant-numeric:tabular-nums}
.mw-editor{position:absolute;top:calc(100% + 6px);right:0;width:208px;box-sizing:border-box;padding:10px;border-radius:12px;
  border:1px solid color-mix(in srgb,var(--mw-line-2) 84%,transparent);
  background:color-mix(in srgb,var(--mw-bg) 98%,transparent);
  -webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);
  box-shadow:0 18px 40px -24px rgba(12,16,24,.5);z-index:3}
.mw-editor form{display:flex;gap:6px}
.mw-editor input{flex:1;min-width:0;height:26px;padding:0 8px;box-sizing:border-box;border-radius:6px;
  border:1px solid var(--mw-line-2);background:transparent;color:var(--mw-text);font:inherit;font-size:11px;outline:none}
.mw-editor input::placeholder{color:var(--mw-caption)}
.mw-editor input:focus{border-color:color-mix(in srgb,var(--mw-accent) 55%,transparent)}
.mw-editor .mw-add{height:26px;padding:0 9px;border:0;border-radius:6px;background:color-mix(in srgb,var(--mw-text) 8%,transparent);
  color:var(--mw-text-2);font:inherit;font-size:11px;cursor:pointer}
.mw-editor .mw-add:hover{background:color-mix(in srgb,var(--mw-text) 13%,transparent)}
.mw-editor .mw-add[disabled]{opacity:.5;cursor:default}
.mw-note{min-height:13px;margin-top:4px;font-size:9.5px;color:var(--mw-up)}
.mw-editor ul{list-style:none;margin:2px 0 0;padding:0;max-height:132px;overflow:auto}
.mw-editor li{display:flex;align-items:center;gap:6px;height:24px;font-size:10.5px;color:var(--mw-text-2)}
.mw-item-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mw-item-code{font-size:9px;color:var(--mw-caption);font-variant-numeric:tabular-nums}
.mw-remove{width:16px;height:16px;flex:none;display:grid;place-items:center;padding:0;border:0;border-radius:4px;
  background:transparent;color:var(--mw-caption);cursor:pointer}
.mw-remove:hover{background:color-mix(in srgb,var(--mw-up) 10%,transparent);color:var(--mw-up)}
.mw-remove[disabled]{opacity:.3;cursor:default}
@media (prefers-reduced-motion: reduce){
  .mw-spin,.mw-dot,.mw-live,.mw-ellipsis i{animation:none !important}
  .mw-face{transition:none}
}
`;

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get ? ctx.get('locale') : undefined;
        translate = makeTranslate(locale);
        try {
          const active = locale && locale.getLocale ? String(locale.getLocale().active || '') : '';
          if (active) lang = active.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
        } catch (error) {
          /* keep the browser default */
        }

        ctx.effect(() => {
          const style = window.document.createElement('style');
          style.setAttribute('data-dsh-plugin', NS);
          style.textContent = CSS;
          window.document.head.appendChild(style);
          return () => style.remove();
        });

        ctx.effect(() => {
          if (!locale || typeof locale.register !== 'function') return undefined;
          const disposers = [];
          for (const id of ['zh', 'en']) {
            try {
              disposers.push(locale.register(NS, id, DICT[id]));
            } catch (error) {
              /* a namespace may already be registered by a previous generation */
            }
          }
          return () => {
            disposers.forEach((dispose) => {
              try {
                dispose();
              } catch (error) {
                /* ignore */
              }
            });
          };
        });

        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: NS, order: 30, locale: NS },
            MoyuSeat,
          ),
        );
      },
    };
  },
});
