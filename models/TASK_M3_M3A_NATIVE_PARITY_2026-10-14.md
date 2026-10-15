# Задача: M3/M3A — точность моделей относительно StarCraft II

Дата: 14.10.2026. Workspace: C:/MODDING. Специализация существующей роли **[Blizzard] Formats: Models**.
Входной файл: C:/MODDING/TASK_M3_M3A_NATIVE_PARITY_2026-10-14.md. Он ссылается на это единственное подробное задание.

## 1. Цель и первый результат

Доработать существующие M3/M3A codecs и нейтральную проекцию моделей так, чтобы анимации,
геометрия, skinning, модельные камеры, материалы и свет максимально соответствовали SC2.
Критерий — устранение измеренного различия с игрой, а не число прочитанных полей или сходство
со сторонним viewer. Не создавать второй parser, renderer, resource resolver или формат UVA/UVC.

Первый срез: проверить native interpolation M3A Raynor и Kerrigan в Cutscene_Epilogue01Arrival,
исправить подтверждённый дефект у существующего владельца и получить PNG и короткий WebP через
публичный Host/MCP и общий scene. Если native oracle пока недоступен, выпустить воспроизводимое
исследование расхождения и обозначить предел точности; выбор стороннего алгоритма не означает parity.

## 2. Вход в сессию и границы

Прочитать AGENTS.md workspace и Blizzard, применимый PROMPT.txt (отсутствие зафиксировать),
C:/MODDING/.claude/agents/blizzard-formats.md, HANDOFF_MODELS_CONVERSION_2026-09-25.md,
models/README.md, codec/provider manifests и provenance/extraction manifests. Старый handoff — история,
не достоверный перечень отсутствующего функционала. Применить implement-modkit-game-mcp и codec workflow.
Роль из .claude-файла не требует менять модель этой сессии.

Текущий consumer описан в starcraft2/modules/cutscene/AGENT_HANDOFF.md и
RENDER_REFERENCE_RESEARCH_2026-10-14.md. Обязательно прочитать [аудит OpenRealm](OPENREALM_REVIEW_2026-10-14.md).

| Ответственность | Владелец |
| --- | --- |
| Native M3/M3A parse/evaluate/write, binding, native→neutral lowering, codec tests/diagnostics | Этот агент, modkit-extensions-blizzard/models |
| Cutscene time/shot/LookAt, actor presentation, ссылки на ресурсы и authoring | MODKIT-CUTSCENES; не переносить player внутрь Models |
| Общий sampler, SDK/UV contracts, CPU/WebGL shaders, RTT targets и passes | MK Core через INTEGRATOR |
| CModel/CLight data resolution | Существующие catalog owners; shared extraction Maps через INTEGRATOR |
| Shared dist, vendor, acceptance, VSIX | Только INTEGRATOR |
| UV Foundation/specs/Runtime, возможные пробелы контракта | Их текущий владелец через INTEGRATOR |

Ты не один в общем checkout. На входе только read-only audit и fresh git status. Не revert/stash/commit
чужие изменения, не пересобирать shared dist. Dirty Models paths принадлежат MODKIT-CUTSCENES KEEP:

- models/codecs/m3/codec.json;
- models/src/m3/codec.js;
- models/src/m3/uvm/converter.ts;
- models/src/m3/uvm/preview.ts;
- models/test/m3-animation-projection.test.ts;
- models/test/m3-installed-render.test.ts;
- models/test/m3-static-preview.test.mjs.

Передача этих consumer hunks возможна позже, только exact handoff через INTEGRATOR. Сессия Cutscenes
сохраняет адаптер и не начинает новых Models implementation изменений. Proposed first implementation
boundary: чистые native/animation/evaluator.ts, tracks.ts, animation-projection.ts и отдельные focused
tests. Перед изменением проверить свежий status и согласовать точную границу, включая callers.

Работа в main. Все временные corpus/build/output — C:/MKTEMP. Игра:
F:/GAMES/Blizzard/StarCraft II через public Host ContentSources/ResourceSessionPort.
Не писать одноразовый CASC/MPQ reader. References read-only. Перед новой возможностью — finder;
перед заменой — PRE/POST removal audit; gate-check подтверждает настоящий checker и test includes.
Все согласования с другими сессиями через INTEGRATOR; ошибку steer не считать доставкой.

## 3. Существующий фундамент: сохранить и использовать

| Возможность | Опора и предел |
| --- | --- |
| Единая библиотека | models/src/m3/native: MD33/MD34, version gates, structures.xml, sections, builders, evaluator/tracks |
| M3A codec и sidecar admission | runtime/animation.js, runtime/sidecar-projection.js, animation-projection.ts |
| Typed base animId binding | dfa6c896: explicit companion с другим hash допускается после проверки привязки; non-explicit правила сохранить |
| Duplicate onset presentation | 22d9359b: opt-in explicit binding, native samples 0/1ms, приближение внутри (0,1ms) диагностировано; raw/default tracks неизменны |
| Material M3A binding | uvm/material-binding.ts, legacy-binding/binding-kernel и provenance: сначала проверить существующий merge |
| Путь модели | Host ModelResources → M3 codec → UVM → common scene; frame не разрешает ресурсы заново |
| Cameras/light projection | CAM_/LITE facets и executable tracks уже есть; не считать отсутствующими по старому handoff |
| Native encoding | Source-free UVM encoder/native write/edit prepare, без blob исходных байтов в residual |
| RTT contract | Core bcb9ca2c: RenderTextureChannel 0..6; compiled dependency/validator/passes ещё проверить |
| Frame contract | Core 44b1d440, F1; F2/F3 статус через INTEGRATOR, dirty source не опубликованный API |

Дополнительные baseline hashes: shared catalog model 07a85b6d, animation name matcher Core391e76bc,
Blizzard vendor1a732029, research ffec7564. Проверить наличие в fresh HEAD и фактическую версию bundles.

Не обещать byte-identical UVM→native regeneration: README допускает иные padding/section placement.
Различать untouched native pass-through и semantic regeneration. M3A остаётся animation-only;
UVM с активными render meshes нельзя молча записать как M3A.

## 4. Референсы и доказательства

Для каждого правила фиксировать native field/version, reference function/revision/hash,
нашу функцию, расхождение, evidence и ограничения. Native SC2/Editor — главный визуальный oracle.
Blizzard документация задаёт поведение редактора, но не все binary/shader details.
Реальный corpus подтверждает наличие полей/времён, не автоматически алгоритм их исполнения.

| Источник | Назначение и ограничения |
| --- | --- |
| references/WhiteoutLib | M3_FILE_FORMAT_SPECIFICATION.md, структуры и reader/writer M3/M3A; проверять версии |
| references/WhiteoutFlakes, https://github.com/FernandoS27/WhiteoutFlakes | AttachAnimationFile/M3AnimTables, cross-file ownership, STC priority, quaternion track/layer interpolation, материалы. SC2 отмечен WIP |
| references/mdx-m3-viewer, https://github.com/flowtsohg/mdx-m3-viewer | Skinning, bone palette, UV/shaders, GPU resource reuse; partial M3 и camera TODO не полный oracle |
| references/open-realm-main/open-realm-main, https://github.com/corepunch/open-realm | Basis/TRS/blend/CMS alpha/CLight; обязательно учитывать ограничения из аудита рядом |
| https://github.com/Solstice245/m3studio и https://github.com/SC2Mapster/m3addon | animId/attachment import, LAYR selectors/flags; Blender 30fps rounding не точный native clock |
| references/m3, references/W3ModelViewer, references/sc2-file-format-docs-main | Проверить фактическое содержимое и версии, не судить о поддержке по названию папки |
| references/modkitmk2, Models binding provenance | Не потерять старые material/animation возможности; не вернуть второй implementation path |
| references/sc2-ida-mcp-setup-main | Изучить имеющиеся аннотации/инструменты, если доступны. Setup не означает работающий IDA или доказанный retail oracle |
| SCII-CutsceneEditorInstructions.pdf | Найти existing local path: camera/clip/fade/RTT authoring, единицы и Editor behavior |

OpenRealm использует slerp между quaternion keys, WhiteoutFlakes — raw component lerp между keys,
а slerp между layers. Они противоречат друг другу: нельзя считать это двумя подтверждениями
одной семантики. OpenRealm также упрощает STC selection, материалы и portrait lighting.

Лицензии проверять по актуальным manifests: Models package declares GPL-2.0-only, Core имеет отдельную
границу. GPL implementation не переносить в Core. References нельзя копировать, кроме предусмотренного
вендоринга с provenance; предпочтительна независимая реализация подтверждённой семантики.

## 5. Порядок работ

### M0 — baseline и feature/gap matrix

Зафиксировать HEAD/artifact versions, installation/baseMods/locale, source hashes, camera/time/viewport,
текущие diagnostics и missing DDS. Получить позы, камеры и material facts через public Host.
Составить severity → owner → минимальное исправление → проверка. Новую архитектуру не строить.

### M1 — native animation precision: первый приоритет

1. Проверить meaning header interpolation и flags0x10, включая runtime-row трактовку для attached M3A.
   Сейчас наш extractor читает header, Whiteout — flags, OpenRealm задаёт TRACK_LINEAR.
2. Разделить интерполяцию между keys и blend между poses/layers. Проверить raw lerp, normalized lerp,
   shortest-path slerp на больших углах, antipodal/non-unit keys. Не менять общий UV sampler под
   недоказанную игровую семантику и не вводить самодельное расширение UV.
3. Signed times (-999), negative playback, 0/last key, duplicate-time boundaries, sequence intervals,
   concurrent wrap/fend/track duration, start/end offsets, hold/loop. Не округлять время к 30fps.
4. STG→STC→STS→SD: принадлежность файлу, stable priority/ties, animId type, initValue fallback.
   Проверить нужность priority sort; subset и sparse channel semantics сохранить.
5. После изменения native policy перепроверить duplicate onset repair. Сравнение нашей projection
   с нашим evaluator не доказывает точность относительно SC2. Исходные keys/residual сохраняются.
6. Bone/material/camera/light refs должны использовать одного владельца native evaluation.

Первые meaningful cases: attached header0 без step flag; два STC с обратным порядком priorities и tie;
large-angle quaternions; duplicate0; signed lead-in; одинаковый animId с несовместимыми target types.
В saved Host Arrival Raynor Stand285/285 step (64 varying), Kerrigan603/603 step (586 varying),
Artanis299 step из642 (78 varying). Это приоритет проверки, не самостоятельное доказательство ошибки.

### M2 — полнота M3A binding и neutral projection

Проверить не только bone TRS: material alpha/color/UV/factors, visibility, CAM lens/bone,
LITE color/intensity/cone/attenuation, поддержанные attachments/effects/events.
Использовать existing material merge. Различать target identity, material layout, clip index и sequence identity.
Material-only M3A не обязано иметь полный skeleton/mesh. STG sidecar не индексировать как базовые SEQS.
Fallback — static base initValue; missing/ambiguous targets дают отказ или diagnostic, без угадывания bone names.

Сохранить limits bytes/sections/tracks/keys/depth, revisions, cancellation, leases/release.
Subset проверяет admission всего companion, публикует только requested poses. Source-free UVM сохраняет
bounded residual/loss receipts, не сырые файлы. Проверить существующих model viewer/native writer consumers.

### M3 — skinning, transforms, attachments, model cameras

Сверить parent/local/rest/IREF, boneLookup/firstBoneLookupIndex, региональные palettes/weights,
nonuniform scale/mirroring, normal/tangent transforms/handedness. Сохранить существующий region split;
не заимствовать ограничение OpenRealm128 bones. Basis и units применяются один раз; камеры, нормали
и lights учитывают тот же space. CPU и GPU получают одинаковую pose, сравнить контрольные точки.

CAM_: реальные camera index/name/native bone, FOV axis, animated FOV/near/far, roll/eye/target.
Common world camera получает ту же bone pose и instance transform, не bounds-derived orbit.
DOF и unsupported lens fields диагностируются. Sockets/collision/billboards наследуют ту же цепочку.
Cutscene LookAt остаётся адаптеру катсцен, не становится эвристикой Models.

### M4 — материалы, текстуры, свет

Обновить матрицу именно исполняемых features: standard/composite и остальные material families;
opaque/cutout/blend/add/modulate, RGB и alpha blend, depth write/cull/priority;
CMS alpha каждого прохода, включая первый, и её animation; COLOR vs bitmap selector;
team/vertex color и coverage; emissive/spec/gloss/normal/AO/lightmap;
channel ops/invert/clamp/factors; UV sets/transforms/wrap/flipbook/triplanar/fresnel/environment.

Подтверждённое отличие: common sampler форсирует первый CMS alpha1; у Raynor первые alpha0.9 и0.5,
у пола/голограммы1. Передать Core минимальный fixture и patch boundary; не писать обходной renderer.
Текстуры — только подтверждённые original DDS, без похожих имён. Missing texture явная диагностика.
Image compression/dimensions/channels/color spaces/normal encoding — existing Image codec owner.

CLight и scene point/spot/directional — existing Data/scene owners; M3 LITE binding/pose/animated fields — Models.
Проверить знак light direction, specular/fill/back semantics, unshaded emissive, clamp/HDR/exposure/output space.
Не заменять всё средним directional light и не брать OpenRealm portrait constants.
Actor tint/opacity исправляют cutscene/Core owners до косметической калибровки яркости.

### M5 — RTT через общий renderer

Models: LAYR video_channel=-1|0..6 → typed renderTextureChannel, независимо от uv_source;
MAT_ rtt_channels_used только dependency mask. Сохранить source bitmap fallback без выдуманной texture.
Prepared patch/test в C:/MODDING/parked/blizzard-formats/rtt-material. Применять лишь после compiled
Core dependency, validator и exact owner boundary через INTEGRATOR.

Cutscene публикует active RTT camera/channel/visibility. Core выполняет bounded secondary passes,
framebuffers/textures, feedback/cycle checks, cancellation/cleanup. Channel0 допустим.
Pose/geometry/material programs переиспользуются между камерами; readback нужен только для экспорта.
Missing camera или unsupported channel не маскировать успешной чёрной текстурой.
Arrival содержит0 RTT; qualification — MissionEpilogue01Start, Raynor screen, около2237 native ms.

### M6 — качество и скорость после семантики

Согласованный linear working/output space; optional RGBA16F проверяется как capability, включая MSAA.
Native tone/exposure operator устанавливать по evidence; произвольный ACES не означает parity.
Shadows/bloom/AA/anisotropy добавлять у общего renderer по измеренному эффекту. Новая WebGPU архитектура
не является предпосылкой. RTT resolution/refresh определяется явным quality budget и зависимостями кадра.

Измерить отдельно cold resolve/conversion, warm seek/pose, GPU upload/draw/RTT/readback;
фиксировать hardware, viewport, scene complexity. Не допускать per-frame CASC/model decode,
geometry rebuild и синхронный RTT readback. Persistent cache проверяет M3A/DDS/Data/context/locale/variation
revisions, а не только primary model revision. Не повышать deadlines/security limits ради успешного теста.

## 6. Игровые сцены для qualification

| Сцена/модель | Проверка |
| --- | --- |
| Campaigns/voidstory.sc2campaign/base.sc2data/cutscenes/cutscene_epilogue01arrival.sc2cutscene | native315000ms, cameraMasterC, Artanis018+1046ms: Artanis/Raynor/Kerrigan, backdrop/hologram;16 выбранных объектов |
| Cutscene_MissionEpilogue01Start.SC2Cutscene | Найти точный logical path/shot через Host, около2237ms: RTT Raynor screen; не перепутать с Arrival |
| Terran04.SC2Scene | Legacy FileNode M3A и Cam_Export; неполный DDS набор, без подмены |
| zLD_ArrivalChar.SC2Cutscene | Leviathan facing/motion/camera/background; без model-name90° patch |
| Nova/Reigel разговор | Existing PNG24s B_s030 и solo WebP23–26s; точный logical path взять из Host evidence |
| Marine и асимметричные fixtures | Bind pose/cardinal heading, weights/region budget, team color |
| Material-only M3A, negative keys, duplicate onset, composite alpha | Малые synthetic cases и discovered real models через Host |

Baseline artifacts: C:/MKTEMP/cutscene-render/arrival-315000-fullhd.png,
arrival-repaired-prepared.bin, arrival-native-315000.json,
arrival-animation-reference-facts.json, arrival-material-facts.json.
Prepared snapshot — diagnostic artifact, не production cache и не fresh Host proof.
PNG1920×1080 до последнего tint mapping; известны facing/LookAt, floor/holo lighting проблемы.
Reference quote: “Zeratul foresaw that this day would come. You have our blades, Kerrigan.”
Native bookmark313954; jumpToBookmark означает raw timeline ≠ video elapsed time.

## 7. Приёмка и поставка

Для каждого fix: before case → native evidence → минимальное owner исправление → regression test →
fresh public Host → common CPU/WebGL кадр → оставшиеся ограничения. Static PNG не подтверждает
интерполяцию между ключами. Reference и native evidence отмечаются раздельно.

- Tests проверяют прежний дефект: endpoints/interior/boundaries, sparse/unrequested/unknown channels,
  dependencies и cancellation. Проверить actual includes и прямой checker; узкий unit gate не весь продукт.
- Poses сравнивать в одном space через матрицы/контрольные точки, учитывать эквивалентные q/-q.
  Tolerance обосновать units/encoding. Не требовать unit quaternion, если исследуемый native путь иной.
- PNG пары получают одинаковую camera/lens/time/resolution/color pipeline. Diff/SSIM дополняются
  проверкой body/camera/material/light/FX по областям; AA/postprocessing могут различаться.
- Conversion/preview/write используют canonical semantics. Writer проверять re-read и semantic comparison,
  loss/residual receipts. Native Editor проверку пользователь отложил; отсутствие oracle явно отметить.
- FaceFX/particles/physics/LookAt не скрывать успешным status. Их graph/runtime semantics остаются владельцам.
  Heroes — после SC2 qualification, без регрессии уже объявленных reader variants.
- Коммиты exact owned paths в main. Зависимые changes park до Core hop; shared dist/acceptance/VSIX — INTEGRATOR.
  VS Code проверяется на committed snapshot; Electron после его приёмки, без обещаний по live source.

Deliverables: актуальная feature/gap matrix, native precision findings, focused commits/tests,
JSON pose/camera/material receipts, PNG пары и короткий WebP, timings с условиями,
models/HANDOFF_M3_M3A_NATIVE_PARITY_2026-10-14.md. Handoff описывает текущее состояние, не дневник.
Задача закрыта после product proof приоритетного среза и явной привязки оставшихся расхождений к владельцам.
Не объявлять full native parity по reader coverage, XML roundtrip или только зелёному unit gate.
