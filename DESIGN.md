# DESIGN.md — 栖光 · 拟光（Lumen）

> AI-readable design system for the 栖光 (Lumen) future-Agent interface. Built on the existing deep-space glass language, formalized to the awesome-design-md 9-chapter standard. Single anthropomorphic subject, proactive perception, emotional feedback, dual-color discipline.

---

## 1. Visual Theme & Atmosphere

栖光 is a being of light that dwells inside the user's device — present, gentle, proactive but never intrusive. The interface is its living space, not a container for features.

- **Design philosophy**: Living Presence — let the agent be "a person who is here", not "a smarter chat box".
- **Visual tone**: deep-space serenity, glass luminosity, organic motion, restrained density.
- **Core keywords**: 在场 (presence) · 拟物 (skeuomorphic life) · 极光 (aurora) · 留白 (negative space) · 呼吸 (breath).
- **Light & material**: frosted glass (`backdrop-filter: blur(18px) saturate(140%)`) over a starfield + aurora void; soft inner highlight (`inset 0 1px 0 rgba(255,255,255,.08)`); no hard drop shadows as decoration — depth comes from layered translucency and aura glow.

## 2. Color Palette & Roles

```css
:root{
  /* Primary — ice-blue, the agent's system language */
  --brand: #5fe1ff;            /* primary actions, agent speech, focus */
  --brand-2: #7af0d4;         /* gradient partner, success-leaning */
  --brand-soft: rgba(95,225,255,.10);
  --brand-glow: rgba(95,225,255,.45);
  /* Brand dark — deep space canvas */
  --app-bg: #060a11;          /* page background, near-black */
  /* Accent / Interactive — warm gold, ONLY the human moment */
  --gold: #f6c062;            /* decision hand-off, "you decide" */
  --gold-soft: rgba(246,192,98,.12);
  --gold-glow: rgba(246,192,98,.42);
  /* Neutral / Gray scale */
  --text: #eaf2f8;            /* primary text */
  --text-2: #a7b6c6;          /* secondary text */
  --text-3: #8295a8;          /* hints, placeholders */
  /* Surface & Borders */
  --border: rgba(255,255,255,.10);
  --border-strong: rgba(255,255,255,.16);
  --panel: rgba(255,255,255,.05);
  --surface-1: rgba(255,255,255,.06);
  --surface-2: rgba(255,255,255,.10);
  --panel-solid: rgba(15,21,31,.72);
  /* Semantic colors — never compete with the dual-color主线 */
  --good: #46e0a8;            /* success */
  --bad: #ff7a7a;             /* error / danger */
  --info: #6fa8ff;            /* informational */
  /* Shadow colors */
  --shadow-soft: rgba(0,0,0,.66);
  --shadow-glow: rgba(95,225,255,.28);
  /* Mood auras — derived by state machine, not manual */
  --mood-calm: rgba(95,225,255,.42);
  --mood-thinking: rgba(111,214,255,.55);
  --mood-speaking: rgba(190,240,255,.60);
  --mood-happy: rgba(126,224,212,.60);
  --mood-concerned: rgba(140,160,200,.50);
  --mood-waiting: rgba(246,192,98,.55);
}
```

| Role | Token | HEX / rgba | Use |
|---|---|---|---|
| Primary | `--brand` | `#5fe1ff` | agent speech, primary buttons, focus ring |
| Gradient mate | `--brand-2` | `#7af0d4` | gradients, soft success |
| Canvas | `--app-bg` | `#060a11` | page background |
| Human moment | `--gold` | `#f6c062` | **only** decision hand-off card |
| Text P1 | `--text` | `#eaf2f8` | headings, body |
| Text P2 | `--text-2` | `#a7b6c6` | captions, labels |
| Text P3 | `--text-3` | `#8295a8` | placeholders, hints |
| Border | `--border` | `rgba(255,255,255,.10)` | hairlines, card edges |
| Surface | `--surface-1/2` | `rgba(255,255,255,.06/.10)` | glass panels |
| Solid panel | `--panel-solid` | `rgba(15,21,31,.72)` | chat / perception backing |
| Success | `--good` | `#46e0a8` | confirm result |
| Danger | `--bad` | `#ff7a7a` | cancel / error |
| Info | `--info` | `#6fa8ff` | deferred |

**Dual-color discipline**: ice-blue = everything functional; warm gold = *only* the human moment. Never use gold for success/warning/error — those use `--good/--bad/--info`.

## 3. Typography Rules

- **Font family**: `"Inter", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, "Segoe UI", sans-serif`
- **Design philosophy**: one primary weight (400) for reading, one emphasis (600) for hierarchy; Chinese line-height 1.55–1.72, Latin 1.28–1.45; chat body capped at 880px centered for readability; the agent's voice uses medium weight in ice-blue, never shouting.

| Token | Size | Weight | Line-height | Letter-spacing | Use |
|---|---|---|---|---|---|
| Display | 28px | 700 | 1.15 | -0.02em | greeting, agent's first words |
| H1 | 23px | 700 | 1.2 | -0.01em | page / section hero |
| H2 | 19px | 600 | 1.3 | 0 | block titles |
| H3 | 15px | 600 | 1.4 | 0 | card titles |
| Body | 14px | 400 | 1.6 | 0.01em | chat / paragraphs |
| Sm | 12.5px | 400 | 1.5 | 0 | helper text |
| Xs | 11px | 500 | 1.4 | 0.04em | labels, timestamps |

## 4. Component Stylings

```css
/* Buttons */
.btn{font:600 13.5px/1 var(--font);padding:9px 15px;border-radius:11px;border:1px solid transparent;cursor:pointer;transition:.16s var(--ease)}
.btn-primary{background:linear-gradient(135deg,var(--brand),var(--brand-2));color:#04141a}
.btn-primary:hover{box-shadow:0 10px 22px -10px var(--brand-glow)}
.btn-secondary{background:var(--surface-1);color:var(--text-2);border-color:var(--border)}
.btn-secondary:hover{color:var(--text);border-color:color-mix(in srgb,var(--brand) 40%,transparent)}
.btn-ghost{background:transparent;color:var(--text-3)}
.btn-ghost:hover{color:var(--text);border-color:var(--border-strong)}

/* Cards — frosted glass, no hard shadow */
.card{background:var(--panel-solid);border:1px solid var(--border);border-radius:20px;
  backdrop-filter:blur(18px) saturate(140%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.08), 0 20px 46px -24px var(--shadow-soft)}

/* Inputs */
.input{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:11px 14px;color:var(--text);font-size:13.5px;outline:none}
.input::placeholder{color:var(--text-3)}
.input:focus{border-color:color-mix(in srgb,var(--brand) 45%,transparent);box-shadow:0 0 0 3px var(--brand-soft)}

/* Navigation — rail */
.rail-btn{display:flex;flex-direction:column;align-items:center;gap:5px;padding:11px 4px;border-radius:14px;color:var(--text-3);background:transparent;border:1px solid transparent;font:600 11px/1 var(--font)}
.rail-btn:hover{color:var(--text);background:var(--panel)}
.rail-btn.active{color:var(--brand);background:var(--brand-soft);border-color:color-mix(in srgb,var(--brand) 30%,transparent)}

/* Badges / Tags */
.badge{font:500 11px/1 var(--font);padding:4px 10px;border-radius:999px;background:var(--surface-1);color:var(--text-3);border:1px solid var(--border)}
.badge-gold{color:var(--gold);background:var(--gold-soft);border-color:color-mix(in srgb,var(--gold) 30%,transparent)}

/* Modals / Human-moment overlay — gold, never modal-blocking */
.human-moment{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(.96);width:min(420px,90%);
  padding:18px 20px;border-radius:13px;background:linear-gradient(180deg,color-mix(in srgb,var(--gold) 14%,var(--panel-solid)),var(--panel-solid));
  border:1px solid color-mix(in srgb,var(--gold) 45%,transparent);
  box-shadow:0 0 0 1px color-mix(in srgb,var(--gold) 20%,transparent), 0 24px 60px -20px var(--gold-glow);
  opacity:0;pointer-events:none;transition:opacity .4s var(--ease),transform .4s var(--ease)}
.human-moment.show{opacity:1;pointer-events:auto;transform:translate(-50%,-50%) scale(1)}
```

## 5. Layout Principles

- **Spacing base**: 4px; scale `4 / 8 / 14 / 22 / 38px` (`--sp-1`…`--sp-5`). Rail width 84px (64px mobile).
- **Grid**: 12-col conceptually; the active stage is a 2-column `1.05fr / .95fr` (presence stage + side column) at >1080px, collapsing to 1-col below.
- **Container**: app is full-viewport (`100vh`); main content padded `0 22px 18px`; presence stage min padding 32px around 栖光.
- **Section spacing**: 14–18px between blocks; 38px between major sections.
- **Whitespace philosophy**: the agent floats in deep void with layered glass; single screen carries at most two hues (ice-blue + neutral), gold only on demand. Generous breathing room — never pack the home screen.

## 6. Depth & Elevation

```css
--shadow-xs:  0 4px 14px -8px rgba(0,0,0,.5);
--shadow-sm:  0 12px 30px -16px rgba(0,0,0,.6);
--shadow-md:  0 20px 46px -24px rgba(0,0,0,.66);
--shadow-lg:  0 30px 70px -28px rgba(0,0,0,.72);
--shadow-glow-brand: 0 0 36px -8px rgba(95,225,255,.45);
--shadow-glow-gold:  0 0 44px -8px rgba(246,192,98,.5);
```

- **Surface layers**: `bg(void) → panel(rgba .05) → surface-1(.06) → surface-2(.10) → panel-solid(.72) → overlay(human-moment)`.
- **Z-index scale**: background 0 · stage 1 · glass panels 2 · content 3 · feedback stack (need-you / notice) 4 · human-moment 20 · command palette 30 · scenario bar 30.
- **Backdrop**: `backdrop-filter: blur(18px) saturate(140%)` on every glass surface; `inset 0 1px 0 rgba(255,255,255,.08)` top highlight.

## 7. Do's and Don'ts

**Do**
- Keep 栖光 present at all times (at least a resting state in the corner).
- Route proactive info through the Perception Stream, in a gentle "whisper" tone — perceive before you speak.
- Derive mood from the state machine; reserve gold strictly for the human moment.
- Funnel every "opening" (type / voice / suggestion / proactive / command) through one `dispatch`.
- Breathe (3.4s organic scale), use slow easing, honor `prefers-reduced-motion`.

**Don't**
- Introduce a second agent visual identity — retire the standalone orb energy-ball; it is 栖光's aura.
- Use gold for success / warning / error — that pollutes the "hand-off" semantics.
- Block the user with modal dialogs; notices / offline / confirm are inline or ultra-light overlays.
- Cram the home screen with 8 layers of information at once.
- Expose manual mood-setting to ordinary users.
- Hardcode color values — always use `--token`.

## 8. Responsive Behavior

| Breakpoint | Width | Behavior |
|---|---|---|
| Mobile | ≤560px | Rail → 64px icon column; greeting 18px; single column; 栖光 becomes a 60px resting orb atop the chat |
| Tablet | 560–860px | Perception stream → collapsible drawer; 栖光 slightly smaller |
| Desktop | 860–1080px | Full 2-column; perception inline |
| Wide | >1080px | Presence stage centered + side column; aurora at full spread |

- **Touch targets**: ≥44×44px for all interactive controls.
- **Collapse strategy**: >1080 three tiers; 860–1080 perception inline; ≤860 single column with 栖光 resting; ≤560 rail icons only.
- **Font scaling**: Display 28→24px, Body stable 14px; never scale body below 13px.
- **`lite` mode**: disable blur & heavy shadows for low-end / mobile (`backdrop-filter:none`).
- **Reduced motion**: stop all animations; render starfield as a single static frame.

## 9. Agent Prompt Guide

**Quick reference** — Build 栖光 UI with: ice-blue `--brand` for all function, gold `--gold` only for human-moment, frosted glass (`blur(18px) saturate(140%)`), 4px spacing base, single anthropomorphic subject (mochi + aura), perception-before-speech, state-derived mood, one `dispatch` for all input.

**Component prompts (copy-ready)**
1. `Generate a frosted-glass card component using --panel-solid, --border, radius 20px, inset highlight and --shadow-md. Include a title (H3) and body (Body).`
2. `Build the 栖光 mochi as inline SVG: rounded body, two eyes with dual highlights, blush, soft-star crown, small feet; data-mood attribute switches face parts via CSS.`
3. `Create a Perception Stream list item: 12.5px text, --surface-1 background, --border, --radius-xs, with an icon and a gentle entrance animation.`
4. `Implement the Human-Moment overlay: gold border/glow, centered, scale-in, four decision buttons (confirm/adjust/defer/ignore); primary button uses --brand not gold.`
5. `Make a Rail nav button: 84px column, icon + 11px label, --text-3 default, --brand + --brand-soft when active.`
6. `Add a global focus ring: :focus-visible { outline:2px solid var(--brand); outline-offset:2px } and respect prefers-reduced-motion.`

**Iteration guide**
1. Start from tokens — never hardcode colors; reference `--brand/--gold/--border/--surface-*`.
2. Confirm 栖光 is visible on every screen (resting state counts).
3. Verify proactive messages flow through Perception Stream, not new popups.
4. Check gold appears ONLY on human-moment surfaces.
5. Ensure all "openings" call `dispatch(text)` — no旁路.
6. Test the 4 breakpoints; touch targets ≥44px.
7. Toggle `prefers-reduced-motion` — everything must still read, just static.
8. Keep one screen ≤2 hues; gold is the rare third.
9. Animate with `--ease` and slow durations (160/320/560ms); breathing 3.4s.
10. After changes, re-run `node --check` on any inline script and a quick render smoke-test.

---
*Authored by Diana (design-md-architect). Companion analysis in `DESIGN-xinglan-future.md`; live prototype in `prototype/xinglan-future.html`.*
