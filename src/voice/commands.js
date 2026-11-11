/**
 * 语音命令表（P3.2 命令快车道）—— **唯一来源**。
 *
 * 每一条 = 一个 intent + 中英两套说法 + 可选参数 + `run(ctx, args)`。
 * 同一张表同时驱动三件事：
 *   ① 快车道执行（`session.onUserText()` → `parseCommand()` → `run(ctx, args)`）；
 *   ② 「教练，我能说什么」帮助面板（`app.js` 的 `renderVoiceHelp()` 直接遍历这张表）；
 *   ③ 测试（`tests/test-voice.mjs` 遍历 `COMMANDS`，每条 intent 的中英说法都至少跑一条）。
 *
 * 硬约束：
 *   - `run()` **只调用注入进来的 `ctx` 里已有的函数**，自己不改任何 state
 *     （ctx 在 `src/app.js` 里组装，见 `voiceCommandCtx`）；
 *   - 文案不写在这里：说法表 / 帮助说明 / 确认语都在 `src/locales/*.js` 的 `coach.*` 下，
 *     由 `i18n.js` 统一取（`tests/test-i18n.mjs` 因此能继续检查中英对称）；
 *   - 没有匹配上就返回 `unknown`（见 `parse.js`），**绝不猜**。
 *
 * `exit` **不再二次确认**（用户要求：说退出就退出 ✓）：`confirm: false`，命令一到就执行。
 * 旧的「确认 / 取消」状态机仍保留在 session.js 里（其它需要确认的动作以后还能用）。
 */

import { t, LOCALES } from '../i18n.js';
import { EXERCISES, EXERCISE_MAP } from '../catalog.js';

/** 等待「确认 / 取消」的最长时间：8 秒没回应自动取消（用户要求） */
export const COMMAND_CONFIRM_MS = 8000;

/** 五个分类的 id（说法里的分类名本身来自 locales 的 `cat.*`，不在这里抄第二份） */
const CATEGORY_IDS = ['upper', 'lower', 'core', 'full', 'stretch'];

/** 从两份词条里取某个 intent 的说法数组（中英各一套；两份 locale 由 i18n 测试保证结构一致） */
function phrases(intent) {
  const zh = LOCALES.zh?.coach?.commands?.[intent];
  const en = LOCALES.en?.coach?.commands?.[intent];
  return {
    zh: Array.isArray(zh) ? zh.slice() : [],
    en: Array.isArray(en) ? en.slice() : [],
  };
}

/** 分类的说法 = 词条里给的变体 + `cat.*` 里的分类名本身（一处定义，不重复搬字） */
function categoryPhrases() {
  const out = phrases('category');
  for (const lang of ['zh', 'en']) {
    const names = CATEGORY_IDS.map((id) => LOCALES[lang]?.cat?.[id]).filter((x) => typeof x === 'string');
    out[lang] = [...new Set([...out[lang], ...names])];
  }
  return out;
}

/** 确认 / 取消的说法（只在「等待确认」状态下匹配，不在命令表里） */
function wordList(key) {
  const zh = LOCALES.zh?.coach?.[key];
  const en = LOCALES.en?.coach?.[key];
  return Object.freeze({
    zh: Object.freeze(Array.isArray(zh) ? zh.slice() : []),
    en: Object.freeze(Array.isArray(en) ? en.slice() : []),
  });
}

export const CONFIRM_WORDS = wordList('confirmWords');
export const CANCEL_WORDS = wordList('cancelWords');

/** 当前 state 的一份只读快照（读取用；绝不改任何东西） */
function snapshotOf(ctx) {
  if (!ctx || typeof ctx.getStateSnapshot !== 'function') return {};
  try {
    return ctx.getStateSnapshot() || {};
  } catch {
    return {};
  }
}

/** 统一的结果：{ key, params } 由 session 用 `t()` 翻成字幕 */
const ack = (key, params) => ({ key, params });

/** 这个动作的目标单位（计时 / 限时计数是秒，其余是次） */
function unitFor(ex) {
  return ex && (ex.kind === 'hold' || ex.timed) ? t('ui.secondsUnit') : t('ui.repsUnit');
}

/** 动作名（当前语言；找不到 id 就原样回 id，绝不抛） */
function exerciseName(id) {
  return EXERCISE_MAP[id] ? t(`ex.${id}.name`) : String(id || '');
}

/** 表项构造：说法从词条取，帮助说明也从词条按 intent 取 */
function command(intent, extra) {
  const say = intent === 'category' ? categoryPhrases() : phrases(intent);
  return Object.freeze({
    intent,
    zh: Object.freeze(say.zh),
    en: Object.freeze(say.en),
    helpKey: `coach.commandHelp.${intent}`,
    ...extra,
  });
}

/* ------------------------------------------------------------------ *
 * 命令表
 * ------------------------------------------------------------------ */

export const COMMANDS = Object.freeze([
  /* ---------------- 导航 ---------------- */
  command('home', {
    run(ctx) {
      ctx.showHome?.();
      return ack('coach.cmdAck.home');
    },
  }),
  command('menu', {
    run(ctx) {
      ctx.openMenu?.({ silent: true });
      return ack('coach.cmdAck.menu');
    },
  }),
  command('next', {
    run(ctx) {
      const ok = ctx.flipMenuPage?.(1);
      return ack(ok ? 'coach.cmdAck.next' : 'coach.cmdAck.notInMenu');
    },
  }),
  command('prev', {
    run(ctx) {
      const ok = ctx.flipMenuPage?.(-1);
      return ack(ok ? 'coach.cmdAck.prev' : 'coach.cmdAck.notInMenu');
    },
  }),
  command('back', {
    run(ctx) {
      const s = snapshotOf(ctx);
      // 有弹窗先关弹窗（和 Esc 的顺序一致：帮助 → 记录 → 运动设定 → 设置）
      if (s.voiceHelpOpen) ctx.closeVoiceHelp?.();
      else if (s.recordsOpen) ctx.closeRecordsModal?.();
      else if (s.exerciseSettingsOpen) ctx.closeExerciseSettings?.();
      else if (s.settingsOpen) ctx.closeSettings?.();
      else if (s.menuMode) ctx.selectFromMenu?.('back');
      else if (!s.homeMode) ctx.openMenu?.({ silent: true });
      return ack('coach.cmdAck.back');
    },
  }),
  command('category', {
    args: 'category',
    run(ctx, args) {
      const id = args && args.category;
      if (!id) return ack('coach.cmdAck.unknownCategory');
      let s = snapshotOf(ctx);
      if (!s.menuMode) ctx.openMenu?.({ silent: true });
      s = snapshotOf(ctx);
      if (s.menuLevel === 1) ctx.selectFromMenu?.('back');
      ctx.selectFromMenu?.(`cat:${id}`);
      return ack('coach.cmdAck.category', { name: t(`cat.${id}`) });
    },
  }),
  command('pick', {
    args: 'index',
    run(ctx, args) {
      const s = snapshotOf(ctx);
      if (!s.menuMode) ctx.openMenu?.({ silent: true });
      const index = Number(args && args.index);
      const name = ctx.pickMenuItem?.(index) || '';
      if (!name) return ack('coach.cmdAck.notInMenu');
      return ack('coach.cmdAck.pick', { index: index + 1, name });
    },
  }),
  command('openSettings', {
    run(ctx) {
      ctx.openSettings?.();
      return ack('coach.cmdAck.openSettings');
    },
  }),
  command('openRecords', {
    run(ctx) {
      ctx.openRecordsModal?.('history');
      return ack('coach.cmdAck.openRecords');
    },
  }),
  command('openBest', {
    run(ctx) {
      ctx.openRecordsModal?.('best');
      return ack('coach.cmdAck.openBest');
    },
  }),
  command('openExerciseSettings', {
    run(ctx) {
      ctx.openExerciseSettings?.();
      return ack('coach.cmdAck.openExerciseSettings');
    },
  }),

  /* ---------------- 训练 ---------------- */
  command('startWorkout', {
    args: 'exercise',
    run(ctx, args) {
      const a = args || {};
      if (a.exerciseId) {
        // 全屏 + 摄像头 / 麦克风权限仍然走**原来那条路**（startGestureMode），不绕开
        ctx.startGestureMode?.();
        ctx.closeMenu?.();
        ctx.selectExercise?.(a.exerciseId);
        if (Number.isFinite(Number(a.value))) ctx.setTarget?.(Number(a.value), a.exerciseId);
        const s = snapshotOf(ctx);
        const name = exerciseName(a.exerciseId);
        if (Number.isFinite(Number(a.value))) {
          const ex = EXERCISE_MAP[a.exerciseId];
          return ack('coach.cmdAck.startWorkoutTarget', {
            name,
            value: s.target ?? Number(a.value),
            unit: unitFor(ex),
          });
        }
        return ack('coach.cmdAck.startWorkoutNamed', { name });
      }
      if (Number.isFinite(Number(a.value))) {
        const s = snapshotOf(ctx);
        const id = s.exerciseId;
        ctx.setTarget?.(Number(a.value), id);
        ctx.startGestureMode?.();
        return ack('coach.cmdAck.startWorkoutTarget', {
          name: exerciseName(id),
          value: Number(a.value),
          unit: unitFor(EXERCISE_MAP[id]),
        });
      }
      ctx.startGestureMode?.();
      return ack('coach.cmdAck.startWorkout');
    },
  }),
  command('pause', {
    run(ctx) {
      const s = snapshotOf(ctx);
      if (s.session === 'running') {
        ctx.pauseSession?.();
        return ack('coach.cmdAck.pause');
      }
      if (s.session === 'paused') return ack('coach.cmdAck.alreadyPaused');
      return ack('coach.cmdAck.pauseNotRunning');
    },
  }),
  command('resume', {
    run(ctx) {
      const s = snapshotOf(ctx);
      if (s.session === 'paused') {
        ctx.resumeSession?.();
        return ack('coach.cmdAck.resume');
      }
      if (s.session === 'running') return ack('coach.cmdAck.alreadyRunning');
      return ack('coach.cmdAck.resumeNotPaused');
    },
  }),
  command('exit', {
    // 说退出就退出（用户要求）：不再走二次确认。确认机制本身仍在 session.js 里
    // （`pendingConfirm` + `COMMAND_CONFIRM_MS`），留给以后真正需要确认的动作。
    confirm: false,
    run(ctx) {
      const s = snapshotOf(ctx);
      // 训练里「退出」= 回手势菜单（和右上角退出圆环同一个动作）；
      // 已经在菜单里再退出 = 回网页首页（和「返回」第一级一致）。
      if (s.menuMode) ctx.showHome?.();
      else ctx.openMenu?.({ silent: true });
      return ack('coach.cmdAck.exit');
    },
  }),
  command('retrySet', {
    run(ctx) {
      const s = snapshotOf(ctx);
      if (s.homeMode || s.menuMode) return ack('coach.cmdAck.retryNotTraining');
      ctx.retrySet?.();
      return ack('coach.cmdAck.retrySet');
    },
  }),
  command('nextExercise', {
    run(ctx) {
      const s = snapshotOf(ctx);
      const list = EXERCISES;
      const at = list.findIndex((e) => e.id === s.exerciseId);
      const next = list[(at + 1 + list.length) % list.length];
      if (!next) return ack('coach.cmdAck.nextExerciseFail');
      if (s.homeMode || s.menuMode) {
        ctx.showWorkout?.();
        ctx.closeMenu?.();
      }
      ctx.selectExercise?.(next.id);
      return ack('coach.cmdAck.nextExercise', { name: exerciseName(next.id) });
    },
  }),
  /**
   * 「继续上次」：回到上次没练完的那个动作 + 目标 + 第几组。
   *
   * 数据来源是**中时记忆**（localStorage 的最近一组 / 服务端 MD 的「上次未完成」），
   * 由 `ctx.continueLastSession()` 负责恢复（这里只把结果翻成一句确认，不碰 state）。
   */
  command('continueLast', {
    run(ctx) {
      const info = ctx.continueLastSession?.();
      if (!info) return ack('coach.cmdAck.continueNothing');
      return ack('coach.cmdAck.continueLast', {
        name: info.name,
        target: info.target,
        set: info.set,
        unit: info.unit || t('ui.repsUnit'),
      });
    },
  }),

  /* ---------------- 目标 ---------------- */
  command('setTarget', {
    args: 'number',
    run(ctx, args) {
      const s = snapshotOf(ctx);
      const id = s.exerciseId;
      const value = Math.round(Number(args && args.value));
      if (!Number.isFinite(value)) return ack('coach.cmdAck.badNumber');
      const next = ctx.setTarget?.(value, id);
      return ack('coach.cmdAck.setTarget', {
        value: Number.isFinite(Number(next)) ? Number(next) : value,
        unit: unitFor(EXERCISE_MAP[id]),
      });
    },
  }),
  command('adjustTarget', {
    args: 'number',
    run(ctx, args) {
      const s = snapshotOf(ctx);
      const id = s.exerciseId;
      const delta = Math.round(Number(args && args.delta));
      if (!Number.isFinite(delta) || !delta) return ack('coach.cmdAck.badNumber');
      const base = Number(s.target) || 0;
      const next = Math.max(1, Math.min(999, base + delta));
      const applied = ctx.setTarget?.(next, id);
      return ack(delta > 0 ? 'coach.cmdAck.adjustUp' : 'coach.cmdAck.adjustDown', {
        delta: Math.abs(delta),
        value: Number.isFinite(Number(applied)) ? Number(applied) : next,
        unit: unitFor(EXERCISE_MAP[id]),
      });
    },
  }),

  /* ---------------- 语音 ---------------- */
  command('mute', {
    run(ctx) {
      ctx.setCoachMuted?.(true);
      return ack('coach.cmdAck.mute');
    },
  }),
  command('unmute', {
    run(ctx) {
      ctx.setCoachMuted?.(false);
      return ack('coach.cmdAck.unmute');
    },
  }),
  command('stopListening', {
    run(ctx) {
      // 关闭教练走的是设置里那个唯一入口（等于 Ctrl+I 关）：停 TTS + 释放麦克风
      ctx.setCoachEnabled?.(false);
      return ack('coach.cmdAck.stopListening');
    },
  }),
  command('help', {
    run(ctx) {
      ctx.openVoiceHelp?.();
      return ack('coach.cmdAck.help');
    },
  }),
  command('switchLang', {
    args: 'lang',
    run(ctx, args) {
      if (args && args.lang) ctx.changeLang?.(args.lang);
      return ack('coach.cmdAck.switchLang');
    },
  }),
  /**
   * 教练声音性别（长期偏好 voiceGender，存在服务端 MD 的 prefs 里）。
   * 命令只把 `female` / `male` 交给 app，音色 ID **只在服务端**（server/volc-tts.mjs）。
   */
  command('setVoiceGender', {
    args: 'gender',
    run(ctx, args) {
      const gender = args && args.gender === 'male' ? 'male' : (args && args.gender === 'female' ? 'female' : '');
      if (!gender) return ack('coach.cmdAck.unknownGender');
      const applied = ctx.setVoiceGender?.(gender);
      const next = applied === 'male' ? 'male' : 'female';
      return ack('coach.cmdAck.voiceGender', {
        gender: t(next === 'male' ? 'settings.voiceMale' : 'settings.voiceFemale'),
      });
    },
  }),

  /* ---------------- 查询 ---------------- */
  command('reportProgress', {
    run(ctx) {
      const s = snapshotOf(ctx);
      const ex = EXERCISE_MAP[s.exerciseId];
      const score = Number(s.score) || 0;
      if (s.homeMode || s.menuMode) {
        return ack('coach.cmdAck.progressIdle', {
          target: Number(s.target) || 0,
          unit: unitFor(ex),
          reps: Number(s.reps) || 0,
          score,
        });
      }
      if (ex && ex.kind === 'hold') {
        return ack('coach.cmdAck.progressHold', {
          seconds: Math.floor((Number(s.holdMs) || 0) / 1000),
          score,
        });
      }
      return ack('coach.cmdAck.progress', { reps: Number(s.reps) || 0, score });
    },
  }),
]);

/** intent → 表项（帮助面板 / 会话按 intent 找 run 用；一处定义） */
export const COMMAND_BY_INTENT = Object.freeze(
  Object.fromEntries(COMMANDS.map((c) => [c.intent, c])),
);

/** 帮助面板的数据行：中文说法 / English / 作用（作用走词条，按当前语言渲染） */
export function commandHelpRows() {
  return COMMANDS.map((c) => ({
    intent: c.intent,
    zh: c.zh.join(' / '),
    en: c.en.join(' / '),
    helpKey: c.helpKey,
  }));
}
