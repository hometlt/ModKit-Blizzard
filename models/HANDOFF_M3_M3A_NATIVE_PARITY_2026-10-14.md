# Handoff: M3/M3A Native Parity

Дата: 15.10.2026. Роль: [Blizzard] Formats: Models. Координатор: [MK] Integrator.
Задание и критерии: [canonical task](TASK_M3_M3A_NATIVE_PARITY_2026-10-14.md).
Текущий baseline: [feature/gap matrix](FEATURE_GAP_MATRIX_M3_M3A_2026-10-14.md).

## Текущее состояние

Последний принятый source-срез REF_ B — `bf36143a7862dfd509696254686bfd8c9aae1bb7`,
parent `a9617060fcb4b8f3fbeddc425c07e59e682f2db1`:11 изменённых source/test путей,
qualification manifest13 с двумя неизменёнными тестами. Core Models дал technical/evidence
ACK; NEW4 принял supplemental proof и закрыл source-only окно. Общая сборка/pickup не выполнены.

Native REF_ control textures больше не публикуются как opaque envi/height/decal color pass.
Поддержанные CMS passes сохраняют alpha/order/priority и исходные ordinal для animation headers.
Referenced standalone/all-REF composite отказывает в render projection через один native owner;
BAT_, PAR_, RIB_, PROJ callers используют существующие bounded boundaries. Source-wide loss
marker проходит в существующий BlizzardM3 residual и блокирует fresh native write до frame/
material approximation; это marker потери, не native material residual или восстановление REF_.
Native parsing/inspection/original-source preserving writer сохранены; full native A остаётся unmet.

Независимые mixed-candidate29+saved2 и отдельный own-staged29+saved2 прошли без skips.
Own blob93bc24… проверен отдельно от foreign RTT WIP. Полный strict в проверенном замыкании
имел4 frozen SDK TS4111; strict адресного helper прошёл, native declaration emission имел
отдельные config/SDK diagnostics. Ни full strict/native/GPU PASS, ни clean-HEAD baseline claim нет.
Saved ArmyRoom00 MATM10/13: удалён только REF_ pass1, pass0/геометрия/material bindings/
skeleton/animation/effects сохранены; ArmyRoom07 MATM2/5 composites неизменны.

Runner остановился после коммита на raw diff CRLF/LF: committed own93bc24… имеет CRLF1002,
live2698cc… — LF1009. Исходный STOPfdc54f… сохранён. Supplemental9ac6f23a… отдельно подтвердил
exact11 blobs,13 raw live SHA, foreign6571/6571 unchanged, indexempty и только прежний RTT9+/2−
при CRLF→LF в памяти; NEW4 принял это без amend/rollback/нормализации файлов/повтора тестов.
Actual-main AFTER audit3a55fe21… сохранил manifests/providers/package и не нашёл новых блокеров.
Артефакты `C:/MKTEMP/m3-reflection-admission-20261015`; durable proof/handoff —
`C:/MODDING/parked/blizzard-formats/reflection-admission-v2-*`.
Parked source/index patches уже применены — не применять повторно. RTT остаётся чужим WIP.

M0a docs commit `f5d48cc92c895fd27e9901e5c764be8547248118` и M1a source commit
`581ce8eaab57ceb6eb2b020106eed2e23094c55a` приняты Integrator. M1a меняет ровно
tracks.ts, animation-projection.ts и новый focused test. Свои source/test changes закоммичены,
индекс этого среза был пуст. Семь прежних Cutscenes KEEP landed в foundation `43c67f52`.
Arrival public Host/render baseline и общая native parity не выполнены.
Новых `native-proven` claims нет; reference findings помечены `reference-qualified`,
исполняемые/native пробелы — `unknown` в матрице.

Прочитаны workspace/repository AGENTS, role, task/review, historical Models handoff,
README, binding provenance, consumer Cutscene handoff/research, developer codec workflow.
`C:/MODDING/PROMPT.txt` отсутствует. Graph discovery доступен в project
`modkit-blizzard-current-20261013`; отдельный tracks snippet имел смещённые строки,
поэтому фактические тела проверены чтением известных source paths.

Source baseline до M0a: Blizzard `0d94cc34a3e38a6f694039b4c3c42146515a4434`, Core
`8eeebb344227b13d60a9a8f3396950c57d5e35bb`, main. Vendor commit `1a732029`.
На M0 shared Models dist не содержал landed bindingBase/duplicate-onset source paths;
точные исторические SHA/UTC mtimes записаны в матрице. Это не fingerprint текущего dist.
Downstream Core F3 base — final `3578c258`; accidental `cc5dadfb` отдельно не использовать.
Это source qualification, не разрешение сборки. Новый Core compiled closure не квалифицирован.

## Исправление вырожденных PHSH (поручение GAME-MINECRAFT)

Source commit `6cabbffa5b43b2ce453caf357f2b68d395e4756a` сохраняет reference-free PHSH v3
с нулевыми осевыми размерами в bounded residual: один 300-байтный record на форму, без
active collision. Reverse объединяет stable body/shape identities; untouched PHSH проходят
rig restoration без изменения signed zero/NaN bits. Unknown shapes/mesh без topology,
отрицательные размеры, внешние references и malformed residual по-прежнему отказывают.
Прежний collidable flag gate сохранён: disabled bodies новым residual не покрыты.

Isolated build: `C:/MKTEMP/m3-degenerate-20261014/head`, архив исходного `1da06b2` плюс
собственные изменения; чужая RTT-правка исключена. Новый quick/owner тест 4 PASS/0 SKIP;
strict production и отдельный strict test noEmit PASS. 12 collision failures старых двух
physics suites воспроизведены на отдельно собранном чистом архиве `1da06b2`
(19 PASS/12 FAIL). Полный гейт зелёным не объявлен.

Свежий public CLI Gateway/WarpGate: 1078476/1078480 байт UVM. Оба используют
`Assets/Buildings/Protoss/GatewayEx1/GatewayEx1.m3`, PHRB7/PHSH0, bone0 `Scene Root`,
Capsule `[2.2729997634887695,0,0]`: это исходные данные, не ошибка смещения (size0/1/2
в physical v3 по offsets92/96/100). UVM provenance содержит предупреждение о residual.
Итоги корпуса и ограничения — `M3_DEGENERATE_PHSH_RECEIPT_2026-10-14.json`.
Sweep завершён: 556/556 успешных export (514 M3, 42 M3A), из 176 multiplayer Unit
VoidMulti трёх рас (74 Zerg/58 Terran/44 Protoss), 241 Actor, primary coverage176/176:
174 прямых связи и 2 подтверждённых morph-reuse (DefilerMPBurrowed/UltraliskBurrowed).
Дополнительных файлов с этой ошибкой не найдено; оба имени врат — один GatewayEx1 asset.
Это не полная рекурсивная проверка всех runtime-spawned effects/cosmetic ModelSwap.
Свежие gas UVM сохраняют все SEQS имена и порядок: Extractor11/11, Refinery14/14,
Assimilator5/5. Native имена `Stand B`, `Stand D`, `GLstand` не переименовывались.
Counterfactual нового теста на чистом production `1da06b2`: 3 FAIL с исходным axial error,
1 PASS (отрицательные размеры), 0 SKIP; исправленная версия — 4 PASS.

Полный reverse Gateway/WarpGate теперь проходит в приватном профиле с фактическим
Core `39eaade6`, без диагностического обхода guard. Fresh public Host worker экспортировал
оба исходных M3 в самостоятельный UVM; public native-encoder восстановил оба M3 по 402800
байт. Встроенные geometry/material/native readback прошли, исходный PHSH300 сохранился
побайтово (SHA256 `194c7f7d08b180d35e3ee974b212a76bcbdd2d5b59c2b0900c0559aae562afb6`).
Общая native parity/оси положительных axial shapes этим не квалифицированы.

## Gateway reverse: DIS_, variation IDs и semantic LAYR (15.10)

Причины были последовательными: Core отвергал намеренно бесцветный `screen-distortion`;
Models не записывал DIS_; variation IDs не учитывали emitter kind/index; исходные физические
LAYR ordinals ошибочно применялись к свежему layout с 18 слоями вместо 14. Core-владелец
исправил только admission/requirements в `39eaade62babf4d0701e3a51a9a2b694a94c0a41`.

Models использует существующие native material/animation writers: DIS_/MATM2 сохраняют
strength values/tracks, normal/height, UV animation, flags и priority; variation ID включает
kind/index. Единственный strict TS `uvm/material-layer-addresses.ts` хранит writer slot mapping
и разрешает реальные MATM→family→LAYR references. Capture/restore связывают headers по
material-reference index, slot и composite pass, сохраняя STC/STS remap и проверки конфликтов.
Обход ограничен бюджетом и отменяется. Чужие standard-material.ts/RTT не менялись.
Прямой Vitest шести файлов: 32 PASS/0 SKIP, включая 6 native-preserving проверок.
Strict production build и отдельный noEmit трёх новых тестов прошли. Variation counterfactual
на исходном `1da06b2` падает на исходной коллизии ID. Новые tests включены в quick/owner.

Старые UVM с physical-only LAYR bindings нужно повторно экспортировать из native M3:
fresh writer явно отказывает вместо применения заголовка другого слоя. Unowned/unsupported
LAYR остаются явным отказом; native preserved-source early branch не изменён.
Подробный результат и source hashes: `M3_GATEWAY_REVERSE_RECEIPT_2026-10-15.json`.
Два именованных прогона относятся к одному unique исходному asset и одному output SHA.
Native Editor/GPU distortion/playback не проверены; исходный DIS_.strength_factor animId/flags
не квалифицированы этим LAYR-срезом. 556-asset corpus с новым capture не повторялся.
Shared dist/vendor/acceptance/VSIX нового среза не обновлялись; pickup ведёт INTEGRATOR-NEW2.
INTEGRATOR-NEW2 проверил strict TS helper и receipt и выдал отдельное окно на ровно 11
Models-файлов; этот коммит фиксирует проверенный срез. Foreign KEEP сохранены, общий
dist/vendor/acceptance/VSIX остаются отдельной очередью интегратора.

Shared dist pickup пока отсутствует. Private portable build разрешал зависимости на current
Core source из-за stale dist/vendor и не является frozen-release proof. Integrator принял
hash в следующую очередь и обещал узкое Models build window после текущей acceptance.
Pipeline pickup не обещать до его фактического rollout; Core/vendor/VSIX не пересобирать.

## Raynor: численная диагностика 15.10

Read-only single-clip probe передан напрямую Cutscenes, thread
`01a1347f-91d0-7972-bd5b-9da41c36b6cc`. Все четыре raw payload из public ContentSources
проверены по SHA256, как и frozen frame/models. Отчёт:
`C:/MKTEMP/cutscene-fidelity-20261014/raynor-single-clip-numeric-20261015-v2.json`, SHA256
`6d233da1e868304b1d561f3aaf5883030ba9308e3ab404b3ce08198772fa8803`;
repro script рядом `raynor-single-clip-probe-20261015.mjs`.
Existing frozen scene sampler выполнен без clip, с Stand 1.489 и Talk 05 .812:
nodes 0/58/60/61, parent-derived local TRS, world/binding matrices, inverse-bind reference,
skin matrices и fixed vertex probes десяти primitives. Diagnostics во всех трёх пусты.

No-clip означает default pose, а не доказанную native bind/rest. Существующий M3SectionList
подтвердил identity TRS defaults всех четырёх raw BONE; saved localPose их сохраняет.
Потеря default values не установлена. Отдельный raw report:
`raynor-raw-bones-20261015-v2.json`, SHA256
`90289d0177721569390117112bd7ae7c6b7be40e61a30da539d61ff56c5457ef`.
V2 исправляет identity: UVM nodes0/58/60/61 по именам соответствуют raw BONE0/45/47/48,
не raw0/58/60/61. Старые raw/loader receipts superseded; generic матрицы были по верным nodeIds.
Отличие default pose от inverse-bind reference само по себе не native defect;
external hierarchy frame явно удалён перед сравнением. Следующее недостающее доказательство —
независимая native default/rest и single-clip joint pose на тех же clock/IDs.
Quaternion/STC/mix policy остаются unknown. Actor world placement отдельно не проверялся.
Production source, shared build, vendor, acceptance и VSIX этим прогоном не менялись.

Дополнительный static loader receipt Cutscenes проверен по всем шести input hashes.
`C:/MKTEMP/cutscene-fidelity-20261014/raynor-loader-scope-20261015-v2.json`, SHA256
`597f225e5fdcf02001bda73a422700b6751e456f0da7144d5a7f8cccaf389d7b`, связывает
Raynor BONE v1/stride160 и offsets18/3c/68/8c с bounded Editor loader RVA1eab2b0.
У четырёх костей location/rotation interp1 flags6; scale/batching interp0 flags6.
Тело предсказывает bit0x10 только для scale/batching, все interp headers заменяет ffff.
Это static prediction для imported image metadata SHA, не dynamic/installed proof.
Post-load attachment writes и quaternion policy из него не следуют; запрос следующего
узкого RE звена отправлен Cutscenes напрямую. M1a semantics этим не расширены.

Quaternion interval probe использует существующие M3AnimationEvaluator и Core
createModelAnimationSampler, без нового playback sampler. Отчёт
`C:/MKTEMP/cutscene-fidelity-20261014/raynor-quaternion-intervals-20261015.json`, SHA256
`23cbc58e9502b09fb6c3e1dfd082664862296fd1150c30db95b0f13570970edf`.
Exact raw sequences Stand3/Talk 05:12, rotation animIds1307548240/1729345852/1238981577/1403485135.
У всех восьми tracks один STC/STS hit, priority0, concurrent false, нет ordering conflict.
Проверены endpoints/.25/.75 всех170 интервалов: negative-dot0, min dot0.9997015086,
тригонометрическая ветка evaluator0 (везде existing near-parallel nlerp branch).
Native-evaluator/UVM max component delta5.23e-8; в requested1.489/.812 максимум5.56e-17.
Самое различающее raw-chord vs normalized interpolation место — Talk05 helmet199–332ms:
.25/.75 raw norm0.99994404, max component delta4.064e-5. В .812 head delta1.375e-5.
Это слабый normalization discriminator, не slerp-vs-nlerp/hemisphere case и не native oracle.
Проверка не установила interpolation mismatch, объясняющий крупное искажение Raynor;
native attachment/mix/basis и skin/vertex execution остаются отдельными неизвестными.

Совместный Talk05 .812 priority4 + Stand1.489 priority3 проверен existing frozen
worldModelAnimation / animation / scene owners. Отчёт
`C:/MKTEMP/cutscene-fidelity-20261014/raynor-composed-layer-evidence-20261015.json`, SHA256
`d2059ce749e86ee3b19986ebacdbdabf579a2306126eaf0fcb99059ecd1fc254`;
script/log рядом. Все4 raw и frozen frame/models hashes проверены;8 owner/reference files
сохранены отдельными content-hash snapshots. Таблица270channels/90 exact-name mappings
включает native seq/STG/STC/STS. Talk05 native12 и Stand native3 имеют один full STC,
оба priority0/concurrent0/STS0,365ids,270/270 genericTRS rawhits/fallback0.
Talk05 выигрывает все270 каналов; Stand0. Combined vs Talk: ноль во всех channel values,
матрицах4 selected nodes и full posed positions всех10 primitives. Vs Stand max matrix
component0.17897828645, max posed coordinate0.02348595113 — разница клипов, не native error.
Raw base118bones, sidecar91; side-only TRS3 у RMR_Mesh_Chest_Light не имеют base animId target.
Partial attachment receipt уже сообщает side-only/nonTRS ограничения; потери selected4bone
каналов не установлено. Reference Whiteout использует per-STC priority/transparency,
play weight/subtrack/dedup и smoothstep budget; generic owner — actor-priority winner.
Это reference semantic gap; fullcoverage/оба nativepriority0 сами по себе native defect
не доказывают. Saved generic packet не содержит weights/transition schedule; проверка raw
authored schedule ниже уточняет конкретную потерю данных. Нового sampler, source/build GO нет.

Authored transition supplement:
`C:/MKTEMP/cutscene-fidelity-20261014/raynor-authored-transition-evidence-20261015.json`, SHA256
`97395ca6ba0a9efdb24a2db43a63acb424790e45ac5a07d352714d31606abd87`.
Public saved scene `inputs/cutscene_missionepilogue01start.sc2cutscene`, SHA256
`248e45794b6d08d479bf6c8e064ea66a720bdb0dd2fbe9f6502637088ab06094`:
actor109/Talk113/Stand121, Talk guid5522805880781586115 start677/duration1056,
blendTime500/blendOutTime450; frame1489 находится244ms до end1733, в последних450ms.
Эти authored переходы не переданы ни как timing, ни как weight в saved generic layers;
это подтверждённое отсутствие передачи данных, не просто гипотетическая weighted возможность.
Artanis строка89 отдельно явно задаёт weight0.5/blendTime1000, его поза этим не проверялась.
Предыдущее замечание об отсутствии authored schedule superseded; оно верно только про packet.
Whiteout ClipPlaylist реализует линейные phase envelopes и умножение desc.weight;
M3 sampler затем отдельно использует smoothstep при объединении слоёв.
Это reference-only, не квалификация SC2 XML→native phase/curve. Вес244/450 не принят за native.
Exact native envelope/trigger/overlap/mask/joint pose остаются unknown; Cutscenes проверяет
свой evaluator/projection и согласует Core API. Models policy/source/build не менялись.
Native trigger caveat: `raynor-transition-trigger-caveat-20261015.json` в том же temp profile
фиксирует static dump SHA6c5316e737509c174aa49d966c005cb33b9b38da275c9bc81a40e1fb8eb5edba.
RVA30815c0 прибавляет поле f8 к двум getter results перед сравнением clock; возможна extension
после main duration. Идентичности getters/trigger пока не доказаны. Last450ms арифметика
не означает активный native blend-out в1489 и не доказывает причину crop.

Whiteout independent reference ЗАПУЩЕН: initial feasibility receipt79332fa5 superseded
successful execution receipt
`C:/MKTEMP/raynor-whiteout-ref-20261015/whiteout-raynor-reference-execution-20261015.json`, SHA256
`fb5f87b90e4c1c29052eb21bb91f823d3d3caf4f4e4190776f5e14469055079f`.
WhiteoutFlakes d2756ce11 clean/read-only, exact WhiteoutLib f3e57087 получен из official
upstream в temp deps/WhiteoutLib; e4b1457cc не подменял pin. Emscripten6.0.10/Node24.16,
external temp CMake собирает18 original/common M3 TUs + thin IO driver, без full viewer.
Original Load/AttachAnimationFile/GetSequences/Evaluate/GetSkeleton/GetMeshes/GetSkinWeights
и SkinningSystem::SkinVertices/ComputeOffsetMatrices выполняются без порта алгоритмов.
Physics0; существующие particle helper headers подключены external force-includes для
upstream physicsguard declaration gap; source не менялся. TerminalNUL trimmed только для
exact name lookup, global sequence3/12 сохранены. Single weight1 Stand1489/Talk05:812.
Comparison `reference-comparison.json`, SHA256
`b17492db34a32763ba97467035f3805bac803b687f40e1f456e94c301bda87c1`:
max world matrix component deltas5.96054e-6/4.66110e-5; skin5.85938e-6/4.72534e-5.
Fixed0/mid/last vertices:17 geosets соответствуют10 unique regions/primitives (composite
materials повторяют geometry); все sourcecoords/active bone names совпали, weightdelta<5e-10.
Max posed coordinate deltas1.04397955e-4/2.52572317e-5. Это reference consistency numbers,
не native game parity, не установленный acceptance threshold и не причина crop.
Raw output97f3b5c8…; wasm8f6bc7b2…; source/commands/inputs hashes и BSD licenses сохранены
в execution receipt. Reference processes exit0. Native toolchain limitations initial
receipt обойдены WASM; новых dependencies кроме exact WhiteoutLib не скачивали.
Нет native blended-pose oracle, whole-model/all-vertex или installed pipeline proof.
Итог передан Cutscenes; production/shared dist/vendor/acceptance/VSIX не менялись.

Communicator camera: original Whiteout Evaluate также выполнен для default-no-clip и
Stand Work0/1489/2237. Execution receipt в том же temp profile
`whiteout-communicator-reference-execution-20261015.json`, SHA256
`9233138b7f79a87750ff3a0ee3bb9d4b65be152b2a33a4ba0f1fe38dfb79eb3e`;
comparison `communicator-reference-comparison.json`, SHA256
`eec6929353a2892214ad4f85db9b7784e13ff2288c31460652e49107c7194784`.
Public raw payload SHA2b23339a86ffc61cf7e273bd25d753c862f0714f8702efbae96bcbf8dd0db551,
saved generic result SHA c04de4416cd4ac768ae7744444d956bd4e2ef2eb8d7c7d620c0beff8a0092ad5.
Raw CAM name independently maps bone6, exact BONEname validated, parent65535/root,
weighted mesh references0. Generic camera bone node6/boneIndex6, external basis node11,
camera childnode8; same-name nodes are not interchangeable. Binding-space bone matrix
delta2.53761e-8 во всех4точках; external frame удалён явно. Inverse-bind reference
сохранён отдельно, default-no-clip не объявлен native bind/rest playback.
Raw FOV/near/far defaults совпадают с generic metadata до decimal output precision,
native selected sequence1 не имеет их треков. Whiteout M3 adapter НЕ предоставляет camera/lens
projection Evaluate API: independent optical forward/up/projection не проверены и не выдуманы.
Existing generic worldWebGlCameraFromModel точно воспроизводит saved camera во всех3clock —
только packet consistency. No +90/FOV tweaks. Новый temp camera driver использует прежние
original static archives; source/reference/previous Raynor artifacts не менялись. Exit0,
pin/source/archive/license/input hashes сохранены, результат передан Cutscenes.

Native optical static qualification: readonly/noanalysis imported Editor image metadata
SHA2147a8d5…,19 raw windows/bytes hashes и actual RET boundaries сохранены в
`C:/MKTEMP/raynor-whiteout-ref-20261015/optical-native/optical-camera-static-evidence-20261015.json`,
SHA256 `a74e47acdd20c769fe2bcf8a23411c0ce778a0e7a87538023d5a1870e9b955c3`.
Frame1d5cb50 model branch после helper17b7ab0 переставляет строки(A,B,C)→(A,-C,B),
но projection17b7de0 использует cameraY для clipW и cameraZ для clipY. Raw row-product
2f4a360 подтверждён. Совместная алгебра C^-1*Pnative даёт optical-Z-forward/+Y-up в
helper-normalized bone frame: intermediate rotation компенсируется projection layout.
Наивный поворот preview camera child НЕ обоснован. Identitychild не менять по этим данным.
Wholeframe RET1d5cfa2, projectionRET1d5c6ea, helperRET17b7ebf; .pdata onebyte не принят заграницу.
Shared world camera действительно берёт child по projectedCameraIndex, metadata bone/6 его
не подменяет. Source proposal NONE; canonical preview.ts остаётся единственным owner.
FOV explicit-override branch имеет углы(F*rho,F) при flag!=0 и(F,F/rho) при flag0,
коэффициенты1/G(angle*.5), G=27323f0. Exact scalar worker/units, CAM runtime constructor,
rect18..34 order и native RTTdestination/aspect пока unknown; defaultviewportbranch отдельно.
В receipt записаны nexttrace anchors; formulas не экстраполировать на guessed RTTaspect.
Normalization scaled/sheared bone frames и installed/native pixel parity не квалифицированы.
Source/reference/shared build не менялись; результат передан Cutscenes. Новые stage/commit —
только через exact NEW4window, как запросил Integrator после67672dd8.

FOV follow-up после `dfdd676f`: bounded native receipt
`C:/MKTEMP/raynor-whiteout-ref-20261015/optical-native/fov-runtime-evidence-20261015.json`,
SHA256 `ffe97012c40176b7844d80cabbab2f470433562bd177d81eae6a59ab95e2fa0c` (revision2).
CAM_ v5 loader1ea73a0 → table initializer1e119c0 →1e62b10 сохраняет sourceCAM в runtime+50;
callback vptr37afad0 slot8=1e61c90 обновляет runtime+38 из CAM+10 animref, fallback CAM+18.
Флаг projection +24 теперь связан с исходным use_vertical_fov. Scalar27323f0/AVX2732760
прослежен до RET; ordinary-range rational совпал с float32 tan(rad) на2049 точках (0 ULP),
это offline expression check, не native execution. Huge-range/exception helpers не доказаны.
Full-subrect default projection: flag0 (sx,sy)=(1/T,rho/T), flag1=(1/(rho*T),1/T), T=tan(F/2).
Explicit override масштабирует углы; выбирать его без фактического bit2 object+2a4 нельзя.
World consumer уже восстанавливает horizontalFOV из request/nativeCamera.fieldOfViewAxis:
в saved Communicator camera на всех3 временах horizontalFieldOfView=0.7610128199953775.
V1 broad generic-axis-loss claim superseded; стандартный yfov отдельно от world metadata recovery.
Own M3 proposal NONE для Communicator: Core Models проверяет отдельный standalone путь;
переиспользовать existing axis contract, не запекать guessed aspect и не вращать child.
Blocker: actual RTT destination dimensions/subrect/mode не установлены; source/shared build не менялись.

## KEEP / исторические exact conflicts

Таблица ниже — граница до foundation `43c67f52`, больше не список текущих dirty файлов.
Текущий KEEP — только чужие RTT hunks в `models/src/m3/native/builder/standard-material.ts`
и `models/test/m3-rtt-material.test.ts`; не stage/revert/commit/включать в свою сборку.
Собственные REF_ hunks standard-material уже в bf36143a; whole-file add/commit захватит RTT.
Numstat исторического baseline: суммарно +470/-144.

| Repository path | Numstat | Содержание dirty boundary |
| --- | --- | --- |
| `models/codecs/m3/codec.json` | +79/-1 | explicit animation resource/subset schema |
| `models/src/m3/codec.js` | +120/-3 | attachment/composition/subset и camera metadata |
| `models/src/m3/uvm/converter.ts` | +6/-0 | camera parent и materializer node mapping |
| `models/src/m3/uvm/preview.ts` | +6/-1 | bone-parent camera |
| `models/test/m3-animation-projection.test.ts` | +68/-0 | subset assertions |
| `models/test/m3-installed-render.test.ts` | +181/-139 | installed render harness |
| `models/test/m3-static-preview.test.mjs` | +10/-0 | camera test |

Чистыми были native/animation/{evaluator.ts,tracks.ts}, animation-projection.ts,
test/native/evaluator.test.ts и m3-negative-key-times.test.ts. Проверить fresh status снова
перед любой правкой. Другие dirty Cutscene/Game/Core paths остаются у своих владельцев.
В Core есть staged и unstaged SDK/Host/Scene changes: dirty source не опубликованный API.

## Принятый M1a и проверки

Finder, PRE и POST removal audits завершены. Existing owner расширен без нового sampler/parser;
потерь операций/data sources/exports не найдено. Dirty manifest Cutscenes не byte-identical HEAD,
но не входит в срез; historical ledger receipts/provenance не менялись.

`M3AnimationReferenceTrackOptions.attachedBaseReference?: true` — internal per-extract marker.
Projection выставляет его только для base BONE location/scale при bindingBase, а memo различает
reference identity + treatment. Для sdr3/sd2v/sd3v flags0x10 задаёт step, иначе linear; raw
header/flags и default own-file path сохранены. Boundary samples, existing duplicate0/1ms repair
и output lineType используют один effective mode. Malformed opted-in non-u16 flags отказывают.
Scalar/SD2V tests — synthetic extractor qualification; product change касается attached SD3V TRS.
`evaluator.ts` и existing evaluator test не менялись.

Итог: focused39 + evaluator14 + binding8 =61 PASS без skips; native noEmit и exact
source/test noEmit PASS (existing relaxed native profile). Counterfactual old tracks:
23/38 FAIL,15 PASS, до добавления последнего duplicate-step case. Diff-check PASS.
POST audit подтвердил request-local cache separation; тест call orders упражняет extractor,
не alias одного объекта одновременно в TRS/batching проекторного memo.

Дополнительный m3-animation suite: current и isolated clean parent b5d095d0 имеют одинаковые
9 PASS/5 FAIL/1 installed SKIP; все имена/status/assertion errors совпадают. Пять memory-Host
cases возвращают unresolved вместо opened. Это baseline/harness blocker данного source config,
причина ещё не установлена, не fresh Host/native acceptance. Shared artifacts не исправлялись.
Receipts/harness в `C:/MKTEMP/m3-native-parity-20261014/`: final-focused.json,
host-baseline-comparison.json, current-animation.json, parent-animation.json,
vitest.source.config.mjs, tsconfig.source.json. Source redirect читает существующую generated
schema data из dist; build/emit не вызывается. Parent clean tracked source распакован через
git archive, dist read-only скопирован, node/dependency environment общий.

Не входит в M1a: quaternion behavior, STC priority/order, Core sampler, converter/codec/preview,
camera/material/RTT и новое resampling без отдельного representation decision.
WhiteoutFlakes — PRIMARY implementation reference по решению владельца, pin
`d2756ce11e0bbb5dac43b97ea5cf1627d53a402b` и file hashes подтверждены локально.
SC2 остаётся final validation. Whiteout claims о runtime row/flags требуют native RE qualification; WhiteoutLib doc
по-прежнему описывает interpolation header, OpenRealm принудительно linear. Не выбирать
семантику голосованием references. glTF rotation LINEAR сам slerp: будущая quaternion правка
не сводится к замене native evaluator.

Авторские RE anchors: M3Anim_BlendQuat_Weighted0x10285442f, Editor BONE0x141EAB2B0,
LAYR0x141EABA80, UV0x102ABBDE0. Executable/platform/build/image hash/base/RVA/xrefs
не квалифицированы; decompilation/tools не запускались. Q1 из
`starcraft2/modules/cutscene/FIDELITY_PLAN_2026-10-14.md` (75695108) прочитан:
quaternion representation, signed clocks/wrap, priorities/weights и non-TRS остаются
отдельными вопросами. Не расширять M1a без нового owner agreement.

## Prerequisites для product proof

1. Согласованная isolated committed Models build и fresh compiled dependency closure.
2. Exact Cutscenes foundation commit/artifact profile для public Host Arrival.
3. Native/проверенное RE evidence либо явный `reference-qualified` предел результата.
4. Отдельный exact handoff consumer/camera/material hunks и installed-render harness при нужде.

RTT patch/test в `C:/MODDING/parked/blizzard-formats/rtt-material` не применять автоматически.
Shared dist/vendor/acceptance/VSIX принадлежат Integrator. Технические вопросы владельцам
разрешено направлять напрямую; Integrator — для сборок, окон и отсутствующих владельцев. Временные outputs только `C:/MKTEMP`; references read-only; игра читается
public Host/ContentSources, без отдельного CASC/MPQ reader. Editor acceptance отложен по task.
