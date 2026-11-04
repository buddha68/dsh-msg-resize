// dsh-msg-resize — 把 DSH 对话区变成可拖动、可缩放的浮窗（Client 半）
//
// 两个手柄：
//   ⠿  右上角：拖动整块消息区（消息列 + 输入框）到对话窗格内任意位置
//   ⤡  右下角：拖动改宽/改高（输入框宽度跟随、高度不变、贴面板下沿）
//   双击各自复位；键盘 ←→↑↓ 微调（Shift 大步）。
//
// 实现要点（都是真机踩出来的，改代码前建议先读）：
//   1. 容器选 [class$="_scrollBody"]——它才是对话滚动容器，改成 position:fixed 后
//      消息区与输入框一起搬，内部滚动照常、输入框仍 sticky 贴下沿。
//   2. 消息列 [class$="_column"] 与输入卡 [class*="_composerStack"] [class$="_card"]
//      不在同一容器，宽度必须两边一起改（差 32px = 输入卡内边距）。
//   3. 活动范围 = 对话内容窗格：左右/下沿取 [class$="_centerCol"] 实时矩形，顶沿用启动
//      时量一次的「对话块自然 top」。运行期绝不清空自己的样式表去测量——那会让宿主
//      重排，拖拽时表现为来回跳（v2.6 修的就是这个）。
//   4. 拖动按下时冻结边界，move 期间不重算；位置没变就不重写样式表。
//   5. 靶点用 CSS-modules 哈希后缀匹配（[class$="_column"]），跨构建稳定；
//      找不到靶点就什么都不做（fail-inert），异常只 console.warn。
//   6. 会话页接管移动后，dsh-chat-drag 的位移在对话页归零、其把手隐藏，
//      避免两个插件各拖一半、把手打架；新建会话页不受影响。
//   7. 全局代际号 __dshMsgResizeGen：热更新后旧实例自停，不抢样式表。
//   8. 位置/尺寸存 localStorage（dshMsgResize.v2），旧版 v1 自动迁移。
window.__ModuleLoader__.load({
	id: "dsh-msg-resize",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;

		var TAG = "[msg-resize]";
		var STYLE_ID = "dsh-msg-resize-style";
		var GRIP_RESIZE = "dsh-msg-resize-grip";
		var GRIP_MOVE = "dsh-msg-resize-move";
		var STORE_V2 = "dshMsgResize.v2";
		var STORE_V1 = "dshMsgResize.v1";
		var PAD = 96; // 面板左右留白合计（每侧 48）：手柄就摆在这条留白里，不压正文
		var CARD_GAP = 32; // 输入卡比消息列宽 32px（真机实测 744 vs 712）
		var MIN_BW = 460;
		var MIN_BH = 320;
		var DEFAULT_BW = 808; // 默认面板宽＝原生消息列 712 + 96
		var EDGE = 8; // 离视口边缘留 8px，保证「不出屏幕」
		var NARROW = 720;
		var HANDLE = 26;
		var GEN_KEY = "__dshMsgResizeGen"; // 全局代际号：热更后旧实例发现代际变了就自停

		var state = {
			started: false,
			gen: 0,
			bw: null, // 面板宽
			bh: null, // 面板高
			x: null, // 面板左上角（视口坐标）
			y: null,
			drag: null, // { kind:"move"|"resize", pointerId, startX, startY, x, y, bw, bh }
			resizeGrip: null,
			moveGrip: null,
			style: null,
			pane: null, // 窗格快照 {left,top,width,height}：top 只在启动/resize 时量，其余实时算
			paneTop: null, // 窗格顶（标签栏下沿），只在样式未写入时量一次
			timer: 0,
			ro: null
		};

		function currentGen() {
			return (typeof window !== "undefined" && window[GEN_KEY]) || 0;
		}

		function stale() {
			return state.gen !== currentGen();
		}

		function log() {
			try {
				console.warn.apply(console, [TAG].concat([].slice.call(arguments)));
			} catch (err) {}
		}

		function clamp(v, lo, hi) {
			if (!Number.isFinite(v)) return lo;
			var top = Math.max(lo, hi);
			return Math.max(lo, Math.min(Math.round(v), top));
		}

		// ── 靶点 ──────────────────────────────────────────────
		function findOne(suffix) {
			try {
				return document.querySelector('[class$="_' + suffix + '"]');
			} catch (err) {
				return null;
			}
		}
		function findColumn() {
			return findOne("column");
		}
		function findScrollBody() {
			return findOne("scrollBody");
		}
		function findSeat() {
			return findOne("composerSeat");
		}
		function findViewArea() {
			return findOne("viewArea");
		}

		function active() {
			return (
				typeof window !== "undefined" &&
				window.innerWidth >= NARROW &&
				Boolean(findColumn()) &&
				Boolean(findScrollBody())
			);
		}

		function fallbackPane() {
			return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
		}

		// 只量「窗格顶」：临时清空自己的样式读一次对话块的自然 top（标签栏下沿），
		// 量完立刻还原。运行期只在启动/window resize 时走这里，绝不在拖拽中清样式
		// （v2.6 抖动根因：拖动中反复清/恢复样式，宿主重排让面板在原生位与浮窗位之间跳）。
		function measurePaneTop() {
			var body = findScrollBody();
			if (!body) return null;
			var saved = state.style ? state.style.textContent : "";
			var top = null;
			try {
				if (state.style) state.style.textContent = "";
				top = body.getBoundingClientRect().top;
			} catch (err) {
				log("量窗格顶失败（忽略）", err && err.message);
			} finally {
				if (state.style) state.style.textContent = saved;
			}
			if (!(top > 0) || top > window.innerHeight - 100) return null;
			return Math.round(top);
		}

		// 窗格实时算：左右/下沿取 centerCol 当前矩形（左栏收展会变），顶沿用启动时量的值。
		// 全程不碰自己的样式表 ⇒ 不会触发宿主重排，也就没有来回跳。
		function refreshPane() {
			var col = findOne("centerCol");
			if (!col) return;
			var r = col.getBoundingClientRect();
			if (r.width < 200) return;
			if (state.paneTop === null) {
				var top = measurePaneTop();
				if (top === null) return;
				state.paneTop = top;
			}
			state.pane = { left: r.left, top: state.paneTop, width: r.width, height: r.bottom - state.paneTop };
		}

		function paneRect() {
			refreshPane();
			return state.pane || fallbackPane();
		}

		// 活动范围＝对话内容窗格（不压左侧栏、不压顶部标签栏），留 8px 边
		function bounds() {
			var pane = paneRect();
			var minX = Math.round(pane.left + EDGE);
			var minY = Math.round(pane.top + EDGE);
			var maxX = Math.round(pane.left + pane.width - state.bw - EDGE);
			var maxY = Math.round(pane.top + pane.height - state.bh - EDGE);
			if (maxX < minX) maxX = minX;
			if (maxY < minY) maxY = minY;
			return { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
		}

		function sizeBounds() {
			var pane = paneRect();
			var maxBw = Math.max(MIN_BW, Math.round(pane.left + pane.width - state.x - EDGE));
			var maxBh = Math.max(MIN_BH, Math.round(pane.top + pane.height - state.y - EDGE));
			return { maxBw: maxBw, maxBh: maxBh };
		}

		// ── 默认几何（没有存档时）：面板默认＝原生列宽 808 × 窗格高，水平居中 ──
		function defaults() {
			var pane = paneRect();
			var bw = clamp(Math.min(pane.width, DEFAULT_BW), MIN_BW, Math.max(MIN_BW, pane.width - EDGE * 2));
			// 默认高度留出上下余量，保证一开始就能上下搬（否则满高时纵向无处可去）
			var bh = clamp(Math.round(pane.height * 0.86), MIN_BH, Math.max(MIN_BH, pane.height - 40));
			var x = clamp(pane.left + (pane.width - bw) / 2, pane.left + EDGE, pane.left + pane.width - bw - EDGE);
			var y = clamp(pane.top + (pane.height - bh) / 2, pane.top + EDGE, pane.top + pane.height - bh - EDGE);
			return { bw: bw, bh: bh, x: x, y: y };
		}

		function ensureGeometry() {
			var d = defaults();
			if (state.bw === null) state.bw = d.bw;
			if (state.bh === null) state.bh = d.bh;
			if (state.x === null) state.x = d.x;
			if (state.y === null) state.y = d.y;
			var sb = sizeBounds();
			state.bw = clamp(state.bw, MIN_BW, sb.maxBw);
			state.bh = clamp(state.bh, MIN_BH, sb.maxBh);
			var b = bounds();
			state.x = clamp(state.x, b.minX, b.maxX);
			state.y = clamp(state.y, b.minY, b.maxY);
		}

		// ── 注入样式 ───────────────────────────────────────────
		function cssText() {
			var colW = Math.max(MIN_BW - PAD, state.bw - PAD);
			var parts = [
				// 面板：整块对话变成浮窗（fixed），圆角+描边+投影，和壁纸分层
				'[class$="_scrollBody"]{position:fixed!important;left:' + state.x + "px!important;top:" + state.y + "px!important;" +
					"width:" + state.bw + "px!important;height:" + state.bh + "px!important;max-width:none!important;max-height:none!important;" +
					"overflow-y:auto!important;overflow-x:hidden!important;z-index:6!important;" +
					"border-radius:14px!important;border:1px solid rgba(255,255,255,.14)!important;" +
					"background:rgba(12,17,20,.55)!important;box-shadow:0 18px 60px rgba(0,0,0,.42)!important}",
				// 消息列 / 输入卡：跟着面板宽度走（差 32px 是输入卡内边距）
				'[class$="_column"]{max-width:' + colW + "px!important}",
				'[class*="_composerStack"] [class$="_card"]{max-width:' + (colW + CARD_GAP) + "px!important}",
				// 让位：对话页由本插件负责移动，chat-drag 的位移归零、把手隐藏（新建会话页不受影响）
				"html{--dd-x:0px!important;--dd-y:0px!important}",
				"[data-dsh-chatdrag-grip]{display:none!important}",
				// 两个手柄：都摆在面板右侧那条 48px 留白里（上＝移动⠿，下＝缩放⤡）
				"#" + GRIP_MOVE + "," + "#" + GRIP_RESIZE + "{position:fixed;width:" + HANDLE + "px;height:" + HANDLE + "px;box-sizing:border-box;" +
					"z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:0;margin:0;" +
					"border:1px solid rgba(255,255,255,.32);border-radius:8px;background:rgba(18,24,28,.62);" +
					"box-shadow:0 2px 6px rgba(0,0,0,.38);opacity:.9;transition:opacity .12s,background .12s,border-color .12s;" +
					"touch-action:none;outline:none;color:rgba(255,255,255,.92);font:600 13px/1 system-ui,sans-serif;cursor:grab}" +
					"#" + GRIP_MOVE + ":hover,#" + GRIP_MOVE + ":focus-visible," + "#" + GRIP_RESIZE + ":hover,#" + GRIP_RESIZE + ":focus-visible" +
					"{opacity:1;background:rgba(77,158,224,.55);border-color:rgba(255,255,255,.75)}" +
					"#" + GRIP_RESIZE + "{cursor:nwse-resize}" +
					"#" + GRIP_RESIZE + "::after{content:'';position:absolute;right:4px;bottom:4px;width:13px;height:13px;" +
					"background:repeating-linear-gradient(135deg,rgba(255,255,255,.92) 0 1.6px,rgba(255,255,255,0) 1.6px 5px);border-radius:1px}" +
					"#" + GRIP_MOVE + "[data-dragging='1']," + "#" + GRIP_RESIZE + "[data-dragging='1']{opacity:1;background:rgba(77,158,224,.72);border-color:#4d9ee0}"
			];
			return parts.join("\n");
		}

		function clearStyle() {
			if (state.style) state.style.textContent = "";
		}

		function apply() {
			if (stale()) return; // 已被新实例接管：不再动样式表
			if (!state.style || !state.style.isConnected) ensureStyle();
			if (!state.resizeGrip || !state.resizeGrip.isConnected) ensureResizeGrip();
			if (!state.moveGrip || !state.moveGrip.isConnected) ensureMoveGrip();
			if (!active()) {
				clearStyle();
				state.resizeGrip.style.display = "none";
				state.moveGrip.style.display = "none";
				return;
			}
			refreshPane();
			if (!state.pane) return;
			ensureGeometry();
			var text = cssText();
			if (state.style.textContent !== text) state.style.textContent = text;
			state.resizeGrip.style.display = "";
			state.moveGrip.style.display = "";
			updateGrips();
		}

		function updateGrips() {
			if (state.moveGrip) {
				state.moveGrip.style.left = Math.round(state.x + state.bw - HANDLE - 10) + "px";
				state.moveGrip.style.top = Math.round(state.y + 10) + "px";
			}
			if (state.resizeGrip) {
				state.resizeGrip.style.left = Math.round(state.x + state.bw - HANDLE - 4) + "px";
				state.resizeGrip.style.top = Math.round(state.y + state.bh - HANDLE - 4) + "px";
			}
		}

		// ── 拖动（移动 / 缩放共用一套）────────────────────────────
		function startDrag(kind, event) {
			if (event.button !== 0 || stale()) return;
			event.preventDefault();
			event.stopPropagation();
			ensureGeometry();
			state.drag = {
				kind: kind,
				pointerId: event.pointerId,
				startX: event.clientX,
				startY: event.clientY,
				x: state.x,
				y: state.y,
				bw: state.bw,
				bh: state.bh,
				// 边界在按下时冻结：拖拽过程中不重算，避免边到边时范围抖动
				bounds: bounds(),
				size: sizeBounds()
			};
			var handle = kind === "move" ? state.moveGrip : state.resizeGrip;
			if (handle) {
				handle.setAttribute("data-dragging", "1");
				try {
					handle.setPointerCapture(event.pointerId);
				} catch (err) {}
			}
		}

		function onDragMove(event) {
			var drag = state.drag;
			if (!drag || drag.pointerId !== event.pointerId) return;
			event.preventDefault();
			var dx = event.clientX - drag.startX;
			var dy = event.clientY - drag.startY;
			var b = drag.bounds || bounds();
			var sb = drag.size || sizeBounds();
			var prevX = state.x;
			var prevY = state.y;
			var prevW = state.bw;
			var prevH = state.bh;
			if (drag.kind === "move") {
				state.x = clamp(drag.x + dx, b.minX, b.maxX);
				state.y = clamp(drag.y + dy, b.minY, b.maxY);
			} else {
				state.bw = clamp(drag.bw + dx, MIN_BW, sb.maxBw);
				state.bh = clamp(drag.bh + dy, MIN_BH, sb.maxBh);
			}
			// 已经钳在边界、这一帧没变化 → 不重写样式（到头时的抖动/闪烁就出在这里）
			if (state.x === prevX && state.y === prevY && state.bw === prevW && state.bh === prevH) return;
			apply();
		}

		function endDrag(event) {
			var drag = state.drag;
			if (!drag || drag.pointerId !== event.pointerId) return;
			state.drag = null;
			var handle = drag.kind === "move" ? state.moveGrip : state.resizeGrip;
			if (handle) {
				handle.removeAttribute("data-dragging");
				try {
					handle.releasePointerCapture(event.pointerId);
				} catch (err) {}
			}
			persist();
		}

		function onKey(kind, event) {
			ensureGeometry();
			var step = event.shiftKey ? 64 : 16;
			var handled = true;
			var b = bounds();
			var sb = sizeBounds();
			if (kind === "move") {
				if (event.key === "ArrowLeft") state.x = clamp(state.x - step, b.minX, b.maxX);
				else if (event.key === "ArrowRight") state.x = clamp(state.x + step, b.minX, b.maxX);
				else if (event.key === "ArrowUp") state.y = clamp(state.y - step, b.minY, b.maxY);
				else if (event.key === "ArrowDown") state.y = clamp(state.y + step, b.minY, b.maxY);
				else if (event.key === "Enter" || event.key === " ") {
					var d = defaults();
					state.x = d.x;
					state.y = d.y;
				} else handled = false;
			} else {
				if (event.key === "ArrowLeft") state.bw = clamp(state.bw - step, MIN_BW, sb.maxBw);
				else if (event.key === "ArrowRight") state.bw = clamp(state.bw + step, MIN_BW, sb.maxBw);
				else if (event.key === "ArrowUp") state.bh = clamp(state.bh - step, MIN_BH, sb.maxBh);
				else if (event.key === "ArrowDown") state.bh = clamp(state.bh + step, MIN_BH, sb.maxBh);
				else if (event.key === "Enter" || event.key === " ") {
					var dd = defaults();
					state.bw = dd.bw;
					state.bh = dd.bh;
				} else handled = false;
			}
			if (!handled) return;
			event.preventDefault();
			event.stopPropagation();
			apply();
			persist();
		}

		// ── 持久化 ─────────────────────────────────────────────
		function persist() {
			try {
				localStorage.setItem(
					STORE_V2,
					JSON.stringify({ bw: state.bw, bh: state.bh, x: state.x, y: state.y })
				);
			} catch (err) {
				log("保存失败", err && err.message);
			}
		}

		function load() {
			try {
				var raw = localStorage.getItem(STORE_V2);
				if (raw) {
					var v2 = JSON.parse(raw);
					if (v2 && typeof v2 === "object") {
						if (Number.isFinite(v2.bw)) state.bw = clamp(v2.bw, MIN_BW, 8000);
						if (Number.isFinite(v2.bh)) state.bh = clamp(v2.bh, MIN_BH, 8000);
						if (Number.isFinite(v2.x)) state.x = v2.x;
						if (Number.isFinite(v2.y)) state.y = v2.y;
					}
					return;
				}
				// v1 迁移：w＝消息列宽、h＝整块高（无位置 → 用默认居中/贴顶）
				var old = localStorage.getItem(STORE_V1);
				if (!old) return;
				var v1 = JSON.parse(old);
				if (v1 && typeof v1 === "object") {
					if (Number.isFinite(v1.w)) state.bw = clamp(v1.w + PAD, MIN_BW, 8000);
					if (Number.isFinite(v1.h)) state.bh = clamp(v1.h, MIN_BH, 8000);
				}
			} catch (err) {
				log("读取存档失败（忽略）", err && err.message);
			}
		}

		// ── 手柄装配 ───────────────────────────────────────────
		function ensureStyle() {
			var existing = document.getElementById(STYLE_ID);
			if (existing) {
				state.style = existing;
				return existing;
			}
			var style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = "";
			document.head.appendChild(style);
			state.style = style;
			return style;
		}

		function bindHandle(el, kind) {
			el.addEventListener("pointerdown", function (event) {
				startDrag(kind, event);
			});
			el.addEventListener("pointermove", onDragMove);
			el.addEventListener("pointerup", endDrag);
			el.addEventListener("pointercancel", endDrag);
			el.addEventListener("keydown", function (event) {
				onKey(kind, event);
			});
			el.addEventListener("dblclick", function (event) {
				event.preventDefault();
				event.stopPropagation();
				var d = defaults();
				if (kind === "move") {
					state.x = d.x;
					state.y = d.y;
				} else {
					state.bw = d.bw;
					state.bh = d.bh;
				}
				apply();
				persist();
			});
		}

		function ensureResizeGrip() {
			// 手柄每次启动重建：旧实例的监听随节点一起丢掉，避免复用节点把拖动打进旧闭包
			var existing = document.getElementById(GRIP_RESIZE);
			if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
			var el = document.createElement("div");
			el.id = GRIP_RESIZE;
			el.setAttribute("role", "button");
			el.setAttribute("tabindex", "0");
			el.setAttribute("aria-label", "拖动调整消息区大小（双击还原）");
			el.setAttribute("title", "拖动：横改宽、竖改高（双击还原大小）");
			bindHandle(el, "resize");
			document.body.appendChild(el);
			state.resizeGrip = el;
			return el;
		}

		function ensureMoveGrip() {
			var existing = document.getElementById(GRIP_MOVE);
			if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
			var el = document.createElement("div");
			el.id = GRIP_MOVE;
			el.setAttribute("role", "button");
			el.setAttribute("tabindex", "0");
			el.setAttribute("aria-label", "拖动移动消息区（双击回原位）");
			el.setAttribute("title", "拖动：把消息区挪到任意位置（不出屏幕；双击回原位）");
			el.textContent = "\u283F"; // ⠿
			bindHandle(el, "move");
			document.body.appendChild(el);
			state.moveGrip = el;
			return el;
		}

		// ── 启动 ───────────────────────────────────────────────
		function start() {
			if (state.started) return;
			state.started = true;
			state.gen = currentGen() + 1;
			try {
				window[GEN_KEY] = state.gen;
			} catch (err) {}
			try {
				load();
				ensureStyle();
				ensureResizeGrip();
				ensureMoveGrip();
				apply();
				window.addEventListener("resize", function () {
					state.pane = null;
					state.paneTop = null;
					apply();
				});
				document.addEventListener("scroll", updateGrips, true);
				// 视图懒挂载/尺寸变化：定时重试 apply，顺带刷新手柄位置
				state.timer = window.setInterval(function () {
					if (stale()) {
						window.clearInterval(state.timer);
						return;
					}
					apply();
				}, 800);
				if (typeof ResizeObserver === "function") {
					state.ro = new ResizeObserver(function () {
						state.pane = null;
						apply();
					});
					var cx = findOne("centerCol");
					if (cx) state.ro.observe(cx);
				}
			} catch (err) {
				log("初始化失败（保持原样）", err && err.message);
			}
		}

		function applyPlugin(_ctx) {
			if (typeof document === "undefined") return;
			if (document.body) start();
			else document.addEventListener("DOMContentLoaded", start, { once: true });
		}

		var inject = ["slots"];
		module.exports.apply = applyPlugin;
		module.exports.inject = inject;
		return module.exports;
	}
});
