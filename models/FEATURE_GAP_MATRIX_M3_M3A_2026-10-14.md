# M3/M3A native parity: feature and gap matrix

Дата: 14.10.2026. Владелец: [Blizzard] Formats: Models, через [MK] Integrator.
Задание: [TASK_M3_M3A_NATIVE_PARITY_2026-10-14.md](TASK_M3_M3A_NATIVE_PARITY_2026-10-14.md).

## Граница доказательства

Документ объединяет исторический read-only M0 и принятый source-срез M1a `581ce8ea`.
M1a проверен focused source tests/noEmit и counterfactual; product/render baseline не завершён.
Для M1a сборки, installed public Host reads, native Editor и GPU-прогоны не выполнялись.
Отдельный capsule-срез `6cabbffa` проверен isolated native/strict build, synthetic PHSH
roundtrip 4/4 без skips и fresh public CLI Gateway/WarpGate. Это не Arrival/render/native
Editor proof; подробности и corpus receipt — в текущем handoff и
`M3_DEGENERATE_PHSH_RECEIPT_2026-10-14.json`. Shared dist pickup ожидает Integrator.
15.10: Gateway/WarpGate reverse проверен с фактическим Core `39eaade6`: fresh public Host
M3→standalone UVM→native-encoder M3, оба по 402800 байт, geometry/material readback и PHSH300
byte identity прошли. DIS_ writer, emitter-specific variation IDs и semantic LAYR owners
проверены отдельно; подробности в `M3_GATEWAY_REVERSE_RECEIPT_2026-10-15.json`.
Это source/private-profile proof; native Editor/GPU/playback и shared artifact pickup не выполнены.
Сохранённые Arrival artifacts из задания не перечитывались как новый oracle.
Installation/baseMods/locale, точные игровые source hashes, позы, камеры, diagnostics,
missing DDS и timings ещё требуют согласованного fresh public Host прогона.

Acceptance labels применяются к конкретному утверждению:

- `native-proven`: поведение подтверждено независимым native SC2/Editor или проверенным
  native RE evidence с идентифицируемой версией. Новых утверждений этого класса в M0 нет.
- `reference-qualified`: установлено чтением конкретного source/reference; это не native parity.
- `unknown`: выполнение/представимость/native semantics ещё не проверены. Название теста
  или наличие поля не повышает этот статус.

Source baseline: Blizzard `0d94cc34a3e38a6f694039b4c3c42146515a4434`, Core
`8eeebb344227b13d60a9a8f3396950c57d5e35bb`, ветки `main`. Последний vendor commit:
`1a732029a7de09526b73f6a09bea49db511fec96`. Версия пакетов сама по себе не доказывает
coherent compiled closure. Models package declares `GPL-2.0-only`; binding provenance
указывает MK2 `1a14ba4eddd0ae88de273348ebd44cfb98a0581d`.

## Матрица

| Приоритет / возможность | Наблюдаемая реализация | Пробел / следующий минимальный шаг | Владелец | Acceptance |
| --- | --- | --- | --- | --- |
| P0 attached M3A interpolation | M1a `581ce8ea`: per-reference `attachedBaseReference` для base location/scale; continuous sdr3/sd2v/sd3v берут step из flags0x10, иначе linear. Raw header/default/evaluator прежние | Source/tests приняты; fresh compiled product и native qualification открыты. Scalar/SD2V coverage синтетическое, не material product fix | Models | `reference-qualified`, unit-tested; native policy `unknown` |
| P0 compiled closure | Shared `models/dist` не содержит landed typed-binding/duplicate-onset paths, перечисленных ниже | Согласованный isolated committed build до executable baseline; общий dist не менять | Integrator | `reference-qualified` для source/dist расхождения |
| P1 quaternion keys / layers | Evaluator использует shortest-path normalized slerp; extractor исправляет hemisphere. WhiteoutFlakes raw key lerp и отдельный layer slerp противоречат OpenRealm | Native/RE qualification и отдельное решение представимости: glTF rotation LINEAR сам использует slerp. Не менять в M1a | Models + Core/UV через Integrator | `unknown` для native semantics |
| P1 STG/STC selection | Текущий resolver выбирает первый STS-valid hit в stored order; priority возвращается как факт. WhiteoutFlakes строит stable priority-desc layers | Проверить native evidence и layer semantics отдельным срезом; не сортировать по догадке | Models; общий compositor — Core | `reference-qualified`; native `unknown` |
| P1 signed times / duplicate onset | Existing signed lead-ins; `22d9359b` opt-in native samples в 0/1ms при explicit binding, diagnostic об интервале (0,1ms) | Повторная проверка после policy change; сохранить raw keys, default path и negative times | Models | Source `reference-qualified`; fresh execution `unknown` |
| P1 typed binding / admission | `dfa6c896`: native animId, base target type, reordered bones и refusals; existing material merge и material-only M3A tests | Сохранить admission всего companion, sparse/subset/unknown channels и budgets. Не заменять index/name matching | Models | Source `reference-qualified`; fresh Host `unknown` |
| P1 camera / skin / transforms | CAM_/LITE tracks, IREF, region palettes, common materializer уже существуют. Dirty camera parent/mapping hunks принадлежат Cutscenes | Exact consumer handoff; fresh common CPU/GPU pose/camera/control points | Models + Cutscenes + Core | Native visual `unknown` |
| P1 composite alpha / material fields | Native CMS multiplier сохранён; research сообщает common first-pass alpha=1. Existing material binding — один owner | Передать Core точный fixture/patch boundary; не писать локальный sampler. Не считать это причиной всего пересвета | Models facts; Core sampler | Reported discrepancy требует fresh proof: `unknown` |
| P1 CLight / LITE | Shared catalog owners и Models native metadata; source light projection уже есть | Active shot, sign, animated fields и color pipeline через текущих владельцев | Maps/shared catalog, Models, Cutscenes, Core | Native lighting `unknown` |
| P2 RTT | Prepared Models patch/test parked; task называет typed Core contract | Compiled validator/dependency и exact handoff до mapping; secondary passes принадлежат Core. Arrival содержит 0 RTT по прежнему research | Models mapping, Cutscenes cameras, Core passes | Fresh execution `unknown` |
| P2 write / source-free residual | Existing native encoder, bounded residual и shared frame removal | Семантический re-read после каждого admitted change; byte-identical regeneration не обещается | Models | Source `reference-qualified`; нового write proof нет |
| P2 FaceFX / FX / look-at | Отдельные owners и явная partial projection | Не скрывать unsupported graph/runtime behavior ради успешного render status | FaceFX/Cutscenes/Core | `unknown` для полного playback |

## Source и compiled artifacts

Это исторические M0 hashes до M1a. Пути относительно этого Models root. Mtime приведён в UTC; вывод о расхождении основан
на содержимом, а не только на времени файла. SHA-256 относится к байтам live checkout.

| Путь | Bytes | Mtime UTC | SHA-256 |
| --- | ---: | --- | --- |
| `src/m3/native/animation/evaluator.ts` | 10504 | 2026-09-04T20:48:22.7818422Z | `822483AB5306E72FCCC26432BE6C2BAF7C3E24897A0876B6636622A1699BA590` |
| `src/m3/native/animation/tracks.ts` | 16765 | 2026-10-14T10:49:51.9326255Z | `A737201CAA1834DE07417DD5F4B6C0B6F4B7E06A3CCBF3AA82112D732BDEC20E` |
| `src/m3/animation-projection.ts` | 26693 | 2026-10-14T10:49:51.9361469Z | `FE53F15E6133FF33044B944C5654B2EF855F68E03ABB852A2479870E45AC0FF4` |
| `dist/m3/native/animation/evaluator.js` | 9530 | 2026-10-02T06:41:21.8215150Z | `028D5D7A9C31583B700368318492E412C17352DEEA7D49A795478A9B5006F4FC` |
| `dist/m3/native/animation/tracks.js` | 12883 | 2026-10-02T06:41:21.8401075Z | `FF5788EE192160C89B65368C4E2C77DA7DC6FA5257E41EDADE2D4FEDF87E79AF` |
| `dist/m3/animation-projection.js` | 21072 | 2026-10-01T16:51:11.5027271Z | `3DD7F75A3E4E8F6D4C0B600DDC422DCF61A1540EF91920D2030F171B89C96F75` |

Source `tracks.ts` содержит `resampleLeadingDiscontinuity`, compiled tracks — нет.
Source `animation-projection.ts` содержит `bindingBase` и `boundaryResampledChannels`,
compiled projection — нет. Нынешний shared dist не доказывает source HEAD/dfa6c896/22d9359b.
Другие dist/bundles и установленные tarball bytes в M0 не квалифицированы.

## Противоречия references

Все references read-only; код не копировался и не исполнялся.
По решению владельца WhiteoutFlakes — PRIMARY implementation reference; окончательная проверка —
SC2/Editor. Pin `d2756ce11e0bbb5dac43b97ea5cf1627d53a402b` и file SHA ниже сверены локально.
WhiteoutLib/OpenRealm помогают выявить расхождения, но не заменяют выбранный reference.

| Reference / версия | Проверенная опора | Вывод и предел |
| --- | --- | --- |
| WhiteoutFlakes `d2756ce11e0bbb5dac43b97ea5cf1627d53a402b` | `src/io/m3/m3_model_adapter.cpp:201–268` | Runtime step по flags0x10; source row0 дополнительно step только flags0x4 + own-file sequence. Attached row0 не тождественен step. Комментарии с native addresses ещё не независимая проверка этих адресов |
| Та же версия | `m3_animation.cpp:167–195,266–294` | Stable priority-desc layers; raw quaternion key lerp без normalization/sign fix; slerp между layers. Отличается от текущего Modkit |
| WhiteoutLib `e4b1457cc1c3630c87ea28381a764e5e53a4bb68` | `docs/M3_FILE_FORMAT_SPECIFICATION.md:230,679–704` | Описывает interpType0=none и interpolation через interpType. Документ противоречит runtime interpretation WhiteoutFlakes |
| Local OpenRealm, см. [review](OPENREALM_REVIEW_2026-10-14.md) | `games/starcraft-2/renderer/r_game.c:92`, `m3/r_m3_load.c:495,533` | Default quaternion slerp, принудительный TRACK_LINEAR, unsigned times. Не подтверждает attached M3A/flags policy |

Reference SHA-256:

- WhiteoutFlakes `m3_model_adapter.cpp`: `3D19346D8A420B45CF045EDD82AF5B31874095CB7C1559ED7E24F789C31F0E10`.
- WhiteoutFlakes `m3_animation.cpp`: `D75C00562CCA5D61FA2679B8131A1C7F1563358317E3B3D8472308B3B3C8F8CA`.
- WhiteoutFlakes `m3_animation.h`: `F2CB8CCA257D1F9BF19E36478C7F73DC210E8BE06EF44911EABD9EDFB8E41766`.
- OpenRealm `r_game.c`: `39176C5C41DCF2D480E5BFD8D85616A0098933D9D5AE4569C1DCB3CC02C8E8AE`.

## Existing test inventory и ограничения запуска

`test/native/evaluator.test.ts` закрепляет header0=step, stored-first STC, shortest-path
slerp, init fallback, clamp/hold и concurrent fend. Fixture priority всегда0.
`test/m3-animation.test.ts:387` отдельно закрепляет stored STG order вместо priority;
`m3-negative-key-times`, `m3-animation-binding`, `m3a-binding`, metadata camera/light tests
уже существуют. Это inventory; результат нового запуска отсутствует.

Repository `test/vitest.config.mjs` quick/owner включает `models/test/**/*.test.ts`;
real использует явный список animation/material/skeleton/M3A/UVM corpus tests.
`scripts/run-vitest-tier.mjs` перед Vitest импортирует `models/build.mjs`: tier command
пишет dist и сейчас не разрешён. `models/test/vitest.split.config.mjs` alias-ит live Core
source; его PASS не был бы самостоятельным pinned/installed proof.

## M1a: принятый source-срез и пределы проверки

Commit `581ce8eaab57ceb6eb2b020106eed2e23094c55a`: ровно `src/m3/native/animation/tracks.ts`,
`src/m3/animation-projection.ts`, `test/m3-attached-reference-interpolation.test.ts`.
Finder, PRE и POST removal audits завершены; потерь функций не найдено. Raw/evaluator,
manifests, encoder, quaternion, STC order, Core/material/camera/RTT не менялись.
Memo request-local и различает ref identity + default/attached treatment. Marker выставляется
только base BONE location/scale; batching/rotation остаются default. Effective mode одинаков
для existing boundary/duplicate0 repair и output lineType; нового resampling нет.

- Focused39 + existing evaluator14 + binding8: **61 PASS, 0 FAIL, 0 SKIP**.
- Native noEmit и exact source/projection/new-test noEmit: PASS; профиль последней проверки
  наследует существующий relaxed native config, не является полной strict/product сборкой.
- Counterfactual со старым HEAD tracks: **23 FAIL / 15 PASS** из первоначальных38 focused cases.
  Последний duplicate-step case добавлен после counterfactual; его parent result не заявляется.
- Дополнительный source-config `m3-animation.test.ts`: current и clean parent `b5d095d0`
  дали одинаковые **9 PASS / 5 FAIL / 1 installed SKIP**. Совпали имена/status и assertion
  errors `unresolved` вместо `opened`. Это baseline/harness blocker в этом окружении,
  не принятый public Host proof; корневая причина пяти отказов пока не установлена.
- Shared dist hashes из M0 сохранены. Config redirect использует owning M3 source;
  исключение — существующий `structures.generated.js` (schema data) без emission.

Receipts/harness: `C:/MKTEMP/m3-native-parity-20261014/`:
`final-focused.json`, `host-baseline-comparison.json`, `current-animation.json`,
`parent-animation.json`, `vitest.source.config.mjs`, `tsconfig.source.json`.
Parent archive содержит clean tracked Models/CASC source; существующие dist скопированы,
dependency junctions указывают на то же окружение. `models/build.mjs` не вызывался.

Primary reference RE anchors остаются авторскими claims без qualification executable/build/image
hash/base/RVA/xrefs: `M3Anim_BlendQuat_Weighted 0x10285442f`, Editor BONE `0x141EAB2B0`,
LAYR `0x141EABA80`, UV `0x102ABBDE0`. Decompilation/tools не запускались. Последующий
downstream Core F3 base — final `3578c258`, никогда accidental `cc5dadfb` отдельно.
Следующие Q1 вопросы — [fidelity plan](../starcraft2/modules/cutscene/FIDELITY_PLAN_2026-10-14.md);
новая production boundary/build/Host window требует отдельного согласования Integrator.
