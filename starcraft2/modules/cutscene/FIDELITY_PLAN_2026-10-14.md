# Катсцены SC2: план устранения расхождений с игрой

## Приоритеты после сверки нового MCP-Codex v42 (15.10)

Референс обновлён: `1488fa9`, прежние сравнения16actor roots относятся только к `fc0b9a6`.
Новая версия не является engine oracle: её docs явно различают WebGL и неполный CPU PNG,
а tests глубины используют fake GL. Не переносить второй renderer, каталог или shader patcher.

1. **Убрать ложное отражение через владельца Models.** Реальная изоляция draw выявила ArmyRoom00
   MATM10/13: CMS pass1 публикует normal DDS как обычный envi-color с opaque blend0 и перекрывает
   пол. При160x90 pass0 даёт0orange pixels, pass1 —2279/2420, столько же, сколько весь материал.
   Это не FloorGlow07: его raw flags/CMS alpha/geometry/UV прошли отдельные проверки и не
   объясняют дефект00. Models/Core подтвердили отсутствие qualified native reflection backend.
   Простой filter/null недостаточен: текущий residual не сохраняет REF_/CMS tables, writer может
   превратить REF_ в MAT_, а filtering меняет ordinal/animation identity. Нужен owner design
   сохранения native payload/identity или честного отказа fresh-write; остальные проходы сохранить.
2. **Применить квалифицированный native bearing в одном SC2 adapter.** Независимая проверка
   private native image установила schema rotation=[0,0,-90]/rotationZ=-90 и actor helper+90
   передRxRyRz; ctorXYZ0 не заменяет schema defaults. Evidence: native-default-evidence.json в
   C:/MKTEMP/cutscene-native-bearing-20261015. PRIVATE source2 применяет bearing только к
   native nonempty modelLink после axis curves, сохраняя omitted/explicit0 различие. Raw paths
   иActorState прежние. Existing quaternion/basis используются без копии; embedded camera root
   получает тот же transform. Внешний scene context/useSceneRotation отдельно не угадывается.
   Реальный diagnostic315000 показывает поворот5objects, не меняя position/scale/camera/light;
   он saved Host15/16 и не закрывает native/public MCP приёмку. Перед посадкой — owner review,
   focused cleanHEAD-own и live-WIP gates, stage только собственных hunks; затем новый public
   PNG/WebP после материал/свет исправлений. Blanket+90 ко всем props остаётся неверным.
3. **RTT и камера.** Сравнить существующий Scene camera basis с v42: normalized boneY,
   X=Y×Z, Z=X×Y устраняют shear при nonuniform scale. Least-aligned fallback у референса —
   политика preview. Переиспользовать owner math; тестировать источник и экранный материал
   отдельно. Переносить инварианты depthMask-before-clear, прозрачную сортировку, отсутствие
   recursive RTT и channel identity в существующие общие пути, если их проверки выявят пробел.
4. **Свет.** Через canonical CLight helper передать actual ambient cube и независимый
   AmbientEnvironmentMultiplier. v42 ordinary-MAT HDR emissive/local-specular policy отделяет
   unshaded/effects/terrain; не применять multiplier всем семействам. Новый spot half-angle
   уже исправлен относительноfc0. Node/M3 local sources, attachment/active-shot/clock и полный
   допустимый бюджет остаются общим owner slice, без усечения53/48 до ближайшихN.
5. **Постобработка после базового света.** Проверить existing Core tone/color owners перед
   HSL/levels/gamma/ordered Variations/LUT16³ и WhiteShift. v42 GPU pipeline: bloom→WhiteShift
   (кроме Reinhard)→tone→LUT; часть activation/fallback — preview policy. Не выдавать его
   numeric tests за native frame parity и не подбирать gamma под один кадр.

Доказательства: `C:/MKTEMP/cutscene-batch-layers-20261015/armyroom00-pass-coverage.json`,
`whiteout-floor07-comparison-v2.json`; owner material receipts в
`C:/MKTEMP/m3-global-sequence-source-20261015`; новый reference control/profile в
`C:/MKTEMP/cutscene-codex-v42-20261015` (original parser/kernel, private diagnostic only).
Свежий public MCP профиль `C:/MKTEMP/cutscene-curve-mcp-20261015` содержит PNG1280x720
315000/16of16models и WebP256x144/4uniqueframes/2s/16of16models с907c0c03 и retained private
CLight/material-clock. Он всё ещё показывает дефекты facing/reflection/light: это контроль до
исправления, не visual acceptance. Материалы/RTT/reflection/анимации должны проверяться снова
через public MCP после source fixes. Следующие абзацы содержат подробности предыдущих slices.

Текущий результат 15.10: native commands — Blizzard80068da2; generic local standard material
response — Coreff96f6e2 (76focusedPASS/0skips, port-strict0, threeforeignRTT preserved).
Это source landing без shared build и новой visual acceptance. Independent Whiteout Commu camera
bone comparison delta2.53761e-8; raw lens metadata соответствует, полной optical projection oracle нет.
PRIVATE candidates: sparse weighted pose V2 (20tests/strict closure0, actual Artanis lower225 channels
preserved) прошёл Core actual review; первый API slice без дополнительного rest/base аргумента.
V3 exact2 подготовлен отдельно (19tests/strict0,14legacy exact), но carrier/helper wiring ещё ждёт
Core ACK. Shared CLight consumer (25tests, saved-resource integration
Arrival315000/Mission1489/2237) ожидает Integrator closure/landing. Patches сохранены в
C:/MODDING/parked/cutscenes/, manifests/receipts — C:/MKTEMP/cutscene-{weighted-proposal-v2,clight-consumer}-20261015.
Общий CLight owner source уже landed Maps16bc7f15; второго parser/resolver нет. Consumer допускает
только named single-ToD/index0 без inline/transition; current directional profile3, остальное explicit
partial. Strict consumer closure имеет66 foreign Core SDK diagnostics; SAME LIVE baseline даёт
те же66,0new структурно. Это не clean HEAD/green build; SDK maps содержит foreign RTT/opacity WIP.
Mission preset ambient0 требует native local lights; произвольное осветление не исправляет сцену.
Models подтвердил: Commu world уже учитывает horizontal FOV. Native camera axis/matrix evidence
не оправдывает поворот±90; actual RTT destination/subrect/mode ещё неизвестны. Дальше — owner review,
local-light transport/cones и RTT framing, затем новые public PNG/WebP. Камера и поза не подгоняются.
PRIVATE consumer compile/import и public Host worker frames на saved ModContext fixture прошли
Arrival315000/Mission1489/2237 (16objects/3directional, MissionRTT1, fresh game I/O0). Profile:
C:/MKTEMP/cutscene-clight-host-20261015. По последующему прямому поручению пользователя privately
собран existing committed UI lighting bridge: C:/MKTEMP/cutscene-lit-render-v2-20261015. Независимый
boundary3framesPASS, RTT/camera/objects unchanged. Public MCP+installed ContentSources дал PNG
arrival-315000.png1280x720,16/16models. Картинка diagnostic: Raynor спиной, тёмные персонажи,
оранжевый пересвет пола. Frozen Scene/codec-kit пока не включают ff96/e66f material/gain changes;
нужен согласованный current render closure, а не новая реализация. WebP3fps/2s отказан по180s;
меньший WebP256x144/1fps/2s декодируется в2разных кадра, но models15/16 (один запрос отменён).
Полная visual acceptance не достигнута. Попытка30bundledSceneexports обнаружила несовместимость
с frozen MCP RTT entry; её source65testsPASS не являются product proof. Fresh material-leaves
profile сохраняет frozen world dist/RTT и обновляет11material leaves без bundling; MCP import PASS,
runtime materials26+RTT6=32PASS/0skip после сохранения existing RTT admission. Новый public MCP
PNG315000:1280x720/16of16models, SHA86911dc46418e64678780e404535937b1dfb8e486af2667510fd55f611ce2360.
Он побайтно совпал с lighting-only PNG: эффект исправлений на этом кадре НЕ подтверждён. Не
переписывать renderer и не объявлять native улучшение из source/runtime gates.

После этого найден и исправлен PRIVATE single-layer material clock: составная TRS pose теряла
source sequence/time. Existing cache теперь хранит их отдельно; sampler прежний, SDK не расширен,
pose/effect/camera clocks сохранены. Profile C:/MKTEMP/cutscene-material-clock-20261015/runtime,
source2 patch/manifest также parked/cutscenes/material-clock-source2.*. Independent23PASS/0skip,
old samefixture3FAIL. Actual floor ready uniform исправлен с[0,-1] на[0,-.5541189333623855], geometry
иcamera unchanged. Ранний build-import получил реальный OutOfMemoryException при свободнойvirtualmemory
~989MB. После освобождения памяти standalone MCP import PASS, запущен fresh installed-game PNG/WebP.
Bounded source overlay: baseline/proposal70 одинаковых diagnostics, world0/new0,649inputs SHA-exact;
общий Core/SDK check красный. Fresh installed-game MCP PNG получен:1280x720/315000ms/16of16,
SHA95639d2650845b3b6627d174df16ee81ce9ad80b9f5d76f585e8fd1b51b27452. Mean abs RGB delta
[.026,.048,.078]: clock исправлен, но видимое расхождение почти прежнее; Raynor facing, пересвет пола
и тёмные персонажи не исправлены. WebP также получен:256x144/2fps/2000ms,4different decoded frames,16of16models; SHA588ad2448c99f3fa0180f5c8a0927cd1c5b00ac8b2b033058183a5fc1a447040. Native acceptance открыта.
Native raw Light bridge уточнил type2→LightSpot/default→LightOmni; V6+V7 доказали полные углы
hotspot/falloff в радианах и clamp hotspot<=.95*falloff через cos(angle/2). Пропущенные ctor defaults,
маски и полный48/53-light transport ещё не квалифицированы. Source/shared build не разрешены этим render proof.


Дата: 14.10.2026. Пользовательский приоритет: **WhiteoutFlakes — основной референс реализации**.
Игровой кадр SC2/Editor остаётся окончательной проверкой. План детализирует качество U1/U2/U8
из общего `docs/MK3/PLAN_SC2_CUTSCENES_2026-10-13.md`; не создаёт второй универсальный roadmap,
renderer, transport, ресурсный resolver или UV-формат. Редактор и универсализация не блокируют
исправление текущего native preview. RTT включается в проверку cinematic preview сейчас.

## 1. Цель и проверяемые сцены

Сначала обеспечить правильные активные объекты, анимации, placement и камеру; затем живой RTT,
прозрачность/материалы/свет и постобработку. Красивый кадр с неправильной позой не считается исправлением.
Исходные M3/M3A/SC2Cutscene и DDS сохраняются, неизвестные ресурсы не заменяются похожими именами.

| Сцена | Что проверяем |
| --- | --- |
| Cutscene_Epilogue01Arrival | native315000ms, MasterC, Artanis018+1046ms; Artanis/Raynor/Kerrigan, декорации и голограмма. Quote: Zeratul foresaw… You have our blades, Kerrigan |
| Cutscene_MissionEpilogue01Start | 1489nativeMs для пары с новым SC2 Editor reference; 2237nativeMs — дополнительная RTT-проверка и прежний preview. Сопоставить paiur04 effective dependencies с VoidStory baseMods через Host |
| zLD_ArrivalChar | Leviathan facing/movement и камеры; нельзя чинить модель глобальным90° offset |
| Terran04.SC2Scene | Legacy FileNode M3A и Cam_Export; missing DDS остаются диагностикой |
| Nova/Reigel | Разговор: body/eyes, позднее FaceFX; точный источник из existing Host evidence |

Arrival не имеет RTT. Native bookmark313954 и315000ms не равны позиции видео из-за jumps.
Первый comparison содержит выбранный shot, полный набор16 видимых объектов и тот же lens/viewport.
Контроль не ограничивается одиночной моделью или произвольной orbit camera.

## 2. Референсы и исходное состояние

[WhiteoutFlakes](https://github.com/FernandoS27/WhiteoutFlakes) использовать для M3/M3A,
sampling/pose/material/light semantics. Локальный pin:
`C:/MODDING/references/WhiteoutFlakes`, commit`d2756ce11e0bbb5dac43b97ea5cf1627d53a402b`.
Проверить pin перед повторной сверкой; upstream и local могут различаться.

Основные файлы: `src/io/m3/{m3_animation.cpp,m3_model_adapter.cpp,m3_pose_solvers.cpp,m3_billboard.cpp}`;
`src/renderer/profiles/sc2_heroes/{m3_standard_shading.cpp,m3_surface_table.cpp,sc2_heroes_profile.h}`.
SHA256 model_adapter:`3d19346d8a420b45cf045edd82af5b31874095cb7c1559ed7e24f789c31f0e10`;
animation:`d75c00562cca5d61fa2679b8131a1c7f1563358317e3b3d8472308b3b3c8f8ca`.

Whiteout implementation, его комментарии о retail и собственные решения viewer различать.
Например, его profile имеет собственный unit scale и ограничения lights/shadows: это не повод
множить все Modkit actors на100 или объявлять postprocess native. SC2 materials/animations в README
обозначены WIP. При конфликте reference/игра приоритет у воспроизводимого native evidence.

Дополнительные проверки: WhiteoutLib — структуры/версии; m3studio/m3addon — authoring и selectors;
mdx-m3-viewer — skinning/GPU reuse; OpenRealm — basis/matrices/CMS alpha, с ограничениями из
`models/OPENREALM_REVIEW_2026-10-14.md`. Эти проекты не заменяют основной reference.

Состояние: typed M3A admission/duplicate onset landed; материал/camera consumers ещё частично
dirty. Core F3 final base3578c258 и F2bd134963 source landed, compiled runtime отдельно проверяется.
F4 split и dist/vendor/Host окно ещё согласуются. Не использовать accidentalcc5dadfb отдельно.
Existing PNG — diagnostic mixed-stage snapshot, не native parity/fresh committed product proof.
Точный профиль: `models/ARRIVAL_ISOLATED_HOST_PROFILE_2026-10-14.md`.

## 3. Один порядок работ и владельцы

| Шаг | Работа | Владелец | Готовность проверяется так |
| --- | --- | --- | --- |
| Q0 | Baseline и per-actor trace | Cutscenes + Models, общий harness | Одинаковые source/context/time/camera и полный список объектов/ресурсов/diagnostics |
| Q1 | Missing M3A и native animation policy | Models | Keys/interior/endpoints, body/eyes и sparse layers без неподвижных каналов из неверной policy |
| Q2 | Placement, model pose, constraints и camera | Cutscenes + Models; neutral math Core | Силуэты/контрольные точки и camera projection соответствуют native независимо от света |
| Q3 | Сквозной RTT | Cutscenes declarations, Models layer mapping, Core passes | Меняющийся Raynor screen в нужном shot и sampler; ни placeholder, ни статичный bitmap |
| Q4 | Alpha/material/texture/CLight | Models + Cutscenes/Data + Core shader | Проходы/coverage/цвет/блики/normal/light response без пересвета из неверной семантики |
| Q5 | HDR/shadows/postprocess и FaceFX | Existing scene и FaceFX owners | Native frame comparison после Q1–Q4; оставшиеся FX/lip differences явно перечислены |
| Q6 | Product qualification и performance | Integrator + владельцы | Fresh public Host, PNG/WebP/VS Code на согласованной сборке, воспроизводимые timings |

Q1 и trace Q2 можно исследовать параллельно, Q3 начать после подтверждения camera/binding.

Точный следующий material trace: Actor509172 / ArmyRoomSet07 / FloorGlowLines_Orange. В сохранённом
public Host bundle два UV-набора по1368конечных пар; uvSource1 корректно выбирает UV1. Оба CMS
alphaFactor1, unshadedtrue, emission3/1 с оригинальной orange DDS: first-CMS-alpha и потеряUV1 не
объясняют пересвет. Потеря single-layer material-only clock подтверждена: sequence0/Stand315s при
poseclock0 давалfallback; private fix передаёт исходный index/time и правильныйUVoffset из retained
track. Проверить полный clock-fixed render, visibility/variant и native concurrent GLstand. До
pixel→primitive/native sampling proof не менять
множители и не подменять текстуры. Evidence: C:/MKTEMP/cutscene-material-leaves-20261015/floor-material-evidence.json.
CLight resolver extraction не блокирует чтение M3A. Шейдерная косметика не блокирует placement proof.
Один исправленный owner используется model viewer, cutscene preview, MCP/CLI и writer.

### Q0. Baseline с раздельной диагностикой

Сохранить selected installation/baseMods/locale, source hashes, runtime closure, revisions,
native scene time и clip-local time. Для каждого actor: GUID/source offset, model/variation,
M3A paths, выбранные clip identities, weights/priorities, active shot/visible/opacity/tint,
placement matrix, model basis, sampled root/bones и выбранную camera/lens.
Не превращать эти facts в новый публичный registry: расширять existing readonly inspection только
при отсутствии нужных данных. Scene GUID не приводить к Number.

Получить два вида сравнения: unlit/debug geometry и обычный материал. Первый отделяет placement
и animation от света. Сохранить выбранные object IDs и unresolved reasons; failed model не скрывается
из comparison отчёта. Повторять capture на нескольких временах внутри одного shot и через cut.

### Q1. Анимации: привязка, время, policy, смешивание

Сначала trace почему клип не играет: ресурс не разрешён; animId не привязан; выбран пустой/неверный
вариант; incorrect clip-local time; header трактуется как step; слой перекрывает канал; веса/visibility.
Не считать это одной общей проблемой decoder.

Основное подозрение — interpretation on-disk/runtime interpolation fields у M3A-driven моделей.
Наш Arrival snapshot содержит Kerrigan Stand603 step channels,586 меняющихся; Raynor285/64.
Сверить Whiteout SampleRef и loader fixup, flags0x10/0x4, принадлежность собственным/attached sequences.
Проверять не только bone TRS, но material/CAM/LITE refs тем же native owner.

Отдельно проверить track quaternion interpolation и cross-layer blend; generic glTF LINEAR для
rotation не обязательно выражает native track policy. Если нейтральное представление не может
точно сохранить результат, выбрать bounded baking с измеренной ошибкой или согласованный контракт,
а не silently normalize/rename interpolation. Выход за формат не прятать в Blender-подобные30fps.

После scalar/vector policy: signed lead-ins, duplicate0, fend/wrap/hold, offsets/speed,
STG/STC ownership и priority, missing-channel default/transparent behavior, ramps/weighted layers.
Текущий full-weight sparse override не выдавать за полное native mixing. Общий default equal-priority
last-wins уже принят; native STC priority и SC2 layer order квалифицируются отдельно у адаптера.
Не менять Core defaults по непроверенному reference утверждению.

### Q2. Положение, ориентация и камера

Разделить object placement, skeleton pose/root motion, parent/attachment и view projection.
Протокол: отключить animation в diagnostic view → проверить authored placement → включить только
body clip → overlays/constraints → source camera. При этом control matrices сохраняются.
Проверять row/column convention, Euler order/units, handedness, source→UV basis, nonuniform scale,
IREF и места применения transforms; basis и instance transform должны применяться один раз.

Уточнить реальные native поля parent/relative/attachment и animation root motion; не угадывать
семантику по screenshot. LookAt/path и attachment constraints — Cutscenes, M3 bone/billboard/IK — Models.
Порядок evaluation восстановить: какие constraints меняют actor transform, какие отдельные bones,
какие зависят от camera. Циклы/неподдержанные constraints явно диагностировать.

Model camera получает ту же pose + instance matrix; CAM identity/index, horizontal/vertical FOV,
roll/near/far и animated lens не теряются. MasterC/shot switching проверять отдельно от model camera.
Нельзя лечить неправильный Raynor/Kerrigan facing global90°, model-name поправкой или orbit framing.
Математический acceptance: выбранные bone/socket positions, camera eye/target/up и screen projections;
visual acceptance: силуэт и положение рук/головы/крыльев на последовательности native кадров.

### Q3. RTT: закончить весь путь

1. Cutscenes: active channel → authored camera → scene visibility/shot/time; сохранять identity.
2. Models: LAYR signed video_channel=-1|0..6 → neutral renderTextureChannel; uv_source независим,
   MAT_ mask только dependency. Existing parked patch применять после typed dependency/validator.
3. Core: schema/ABI и material validator допускают RTT layer без bitmap; render target binding
   подменяет только нужный sampler, не все material textures.
4. Existing renderer: bounded secondary camera passes, правильные viewport/aspect/lens,
   исключение feedback/циклов, стабильные GPU textures/framebuffers, resize/context-loss/cleanup.
5. Test сначала synthetic channel0 с известным цветом/положением, затем живой Raynor screen.

Reuse pose/geometry/material programs между камерами. Не выполнять RTT→CPU→PNG→texture каждый кадр.
Render только востребованные каналы; изменение camera/time/visibility/resources инвалидирует нужный target.
HDR/вывод не преобразовываются повторно при sampling RTT. Missing camera/channel не становится молча
успешной чёрной текстурой. CPU и WebGL ограничения объявляются раздельно; full product RTT не закрывается
тестом одного layer field. Acceptance — несколько времён с движением на экране и корректной композицией.

### Q4. Материалы и native lighting

Начать с подтверждённых проблем: first CMS alpha, actor opacity/tint, source layer selectors,
animated UV/color/alpha. Пол/голограмма имеют first alpha1, поэтому этот баг не доказан причиной
их пересвета. Не уменьшать всю яркость, чтобы скрыть потерянную opacity или неверный emissive pass.

Проверить RGB/alpha blend отдельно, depth/cull/priority, normal/tangent UNORM decoding и handedness,
COLOR/team/vertex selectors, UV transforms/центр/offset/wrap, factors и animated material tracks.
Сопоставлять M3 lowering и общий shader по одному feature fixture; не копировать SC2 switches в Core.
Native DDS сохраняют path/content/channel semantics; отсутствующие DDS не подбираются по похожему имени.

CLight resolution — одна shared реализация Data owners; cutscene shot выбирает активные lights.
Point/spot position/direction/cone/attenuation, M3 LITE animated params и unshaded emissive передаются
общими контрактами. Specular/fill/back и environment response проверять по data/native, не усреднять
в directional sun. Actor HDR tint/opacity и ограничение light budget должны быть явными.

### Q5–Q6. Качество, лица и поставка

После правильного light/material response согласовать linear/HDR/output pipeline, native exposure,
shadows, bloom и AA. Whiteout profile — основной ориентир конструкции, но его viewer defaults не
доказывают native scene settings. Не добавлять весь deferred renderer лишь ради одной comparison сцены.
Нужные возможности добавляются существующему scene owner; capabilities/fallbacks проверяются.

FaceFX: existing FXA/FXE graph и M3Weight/bone binding; не считать body/eye M3A готовым lipsync.
Эта задача не блокирует Q1–Q4, но comparison говорящих персонажей явно отмечает missing facial behavior.
Particle/ribbon/cloth/native FX — отдельные измеренные gaps, не массовый перенос reference renderer.

Для свежей согласованной сборки сохранить PNG пары и короткие WebP для трёх сцен. Отдельно измерить
cold resource resolve, conversion, warm seek/pose, uploads/draw/RTT/readback. Не обещать FPS до измерений;
per-frame reload/rebuild запрещён, cache учитывает полный dependency closure.
CPU/WebGL результаты проверяются на одной pose/camera; VS Code — на acceptance после Integrator.

## 4. Декомпиляция SC2: точечный второй источник доказательств

**Да, статический анализ SC2/SC2Editor может уточнить спорную семантику.** Предлагается не восстанавливать
весь движок, а отвечать на ограниченные вопросы Q1–Q4: loader fixups, interpolation, blends,
transform order, CAM lens, LAYR ops, RTT routing и light/shader constants.
Изученный proprietary pseudocode не становится новым исходником runtime Modkit; результат —
описание правила, independent implementation и regression fixture.

### Доступность и инструменты (проверено14.10)

Локальный `references/sc2-ida-mcp-setup-main` содержит README/config/agent instructions, но в этой
копии0 `.exe/.i64/.idb`; заявленные README dirs tools/docs/output/old-doc отсутствуют.
Подключённых callable IDA MCP tools в этой сессии нет. Это не готовый decompiled SC2 corpus.
Существование IDA/Ghidra установки вне этого reference не проверено.

- [Официальный Hex-Rays IDA MCP](https://github.com/HexRaysSA/ida-mcp): IDA9.4+ с idalib/Python3.11+.
  Предпочесть совместимый уже установленный путь; metadata/version проверить, не выполнять install из плана.
- [ida-pro-mcp](https://github.com/mrexodia/ida-pro-mcp) — существующий альтернативный bridge;
  его README рекомендует официальный сервер. Local setup не переносить без проверки совместимости.
- Старый [MxIris ida-mcp-server](https://github.com/MxIris-Reverse-Engineering/ida-mcp-server), на который
  ссылается local README, archived. Это реальный setup gap, не отсутствие алгоритмов анализа.
- [Ghidra](https://github.com/NationalSecurityAgency/ghidra) предоставляет disassembly/decompiler и
  автоматизацию без зависимости от IDA. Конкретную версию/Java/processor pipeline зафиксировать.
- [RenderDoc](https://github.com/baldurk/renderdoc) — дополнительный graphics capture для shader bindings,
  buffers, blend/depth state и RTT. Сначала проверить совместимость реального API SC2/Editor/build;
  успешный capture/наличие shaders пока не подтверждены. Не требуется для старта статического анализа.

### Уже найденные anchors Whiteout (ещё не наш native proof)

| Вопрос | Anchor из Whiteout комментариев |
| --- | --- |
| Track interpolation / runtime flags | M3Anim_BlendQuat_Weighted0x10285442f и scalar counterpart |
| Loader interpretation / rewrite полей | SC2Editor BONE sub_141EAB2B0, LAYR sub_141EABA80 |
| Cross-file track tables | sub_1028819E0; M3A merge comments sub_10288B3C0/sub_10288BAB0 |
| Native UV composition | sub_102ABBDE0 |
| Bone matrix policy | M3Anim_EvaluateBoneTransform/rotation rows, ссылки в model_adapter |

Это build-dependent VA, не переносимые RVA/symbols. Не считать их адресами установленной Windows
версии. Для каждого anchor сначала executable/platform/build/image hash, image base, RVA и matching
function signature/xrefs. Whiteout имя функции — annotation автора, не гарантированный retail symbol.

### Процедура одного RE вопроса

1. Формулировка с competing hypotheses и минимальным input: например attached scalar header0,
   большой quaternion угол, nonuniform bone scale, один RTT channel0 или CMS first alpha0.5.
2. Выбрать game/runtime либо Editor/loader binary: их роли различаются. Зафиксировать build/hash;
   локальную analysis copy/database держать в C:/MKTEMP, не в references/repositories.
3. Подтвердить завершение analysis и candidate function через xrefs/layout/field access/callers.
   Псевдокод проверить по assembly для flags, signedness, float math и matrix convention.
4. Записать inputs/outputs/order/defaults и независимый fixture. Runtime mutation of loader fields
   не переносить на immutable on-disk header без проверки момента/принадлежности sequence.
5. Сравнить с Whiteout и нашим source path, затем с native frame/numerical observation, если доступны.
   Одно похожее имя или комментарий не native proof. Противоречия фиксировать, не скрывать.
6. Изменить существующего владельца, выполнить regression и fresh public Host после artifact window.

RE не зависит от имплементации Galaxy/Cutscene natives и не добавляет запуск proprietary renderer в Modkit.
Без доступного binary/database продолжаются reference-qualified fixes и трассировка ресурсов;
план не обещает недоступный native oracle и не блокирует весь preview на полном RE.

## 5. Приёмка, доказательства и ограничение scope

Каждый claim маркируется: source-read / unit-tested / Host-verified / reference-qualified /
native-verified. В артефакте есть source/revision/time/lens и список unresolved effects.
Сравнение себя с собой через собственный sampler полезно для regression, но не доказывает SC2 parity.
SSIM/pixel diff дополняется geometric/pose/material facts; tolerance обосновывается encoding/units.

Первый выпуск: Q1/Q2 на Arrival, без T-pose и неверного facing; следующий — Q3 Raynor RTT;
затем Q4/Q5 и одинаковые полные кадры. Пользователь предоставил native Editor reference
MissionEpilogue01Start на1489ms: Raynor face/helmet в RTT, purple nebula и розово-фиолетовый свет.
Оригинал сохранён в C:/MKTEMP/cutscene-fidelity-20261014/mission-1489-editor-reference.png;
SHA25693770fac1cc81d6986e57f576089812972079992a0da7b87e88377528d621e47.
Title содержит campaign/void/paiur04.sc2map; screenshot не подтверждает build/hash исходного XML.
Arrival reference — отдельно предоставленный пользователем кадр с репликой Artanis018.
Writer и редактор используют исправленную семантику позже, без обязательной конвертации в новый UV файл.

Согласования/commits по владельцам через INTEGRATOR. Models dirty KEEP сохраняется до handoff;
Core F4/material/texture paths не трогать параллельно. F4-A source commit3ff33f0b подтверждён Integrator;
это не закрывает F4-B/C и не обновляет compiled closure. Никаких dist/Host/RE launches в рамках составления
этого плана. References только чтение; license/provenance соблюдаются, исходные game assets не коммитятся.
Один глобальный cross-link добавляет владелец основного плана; этот файл не заменяет U roadmap.

## 6. Проверка SC2Editor-MCP-Codex как дополнительного референса

Локальная read-only ревизия: C:/MODDING/references/SC2Editor-MCP-Codex,
HEAD fc0b9a641ecc3c62ddc365f943653207b196d268 (1.1.0-alpha.20).
Проверены source и целевые test cases; сборка и тесты этого проекта не запускались.
WhiteoutFlakes остаётся основным референсом, native Editor — проверкой результата.
Этот раздел задаёт проверки внутри Q1–Q5, не отдельный план реализации.

Пользовательский кадр программы:2237ticks/2.24s, viewport примерно1641x500.
Nebula и часть материалов/декораций отображаются, но Raynor portrait на communicator отсутствует.
Наш public MCP PNG2237:640x360, RTT содержит неверно кадрированное тело/броню,13/16models converted.
Native Editor reference1489: viewport примерно1296x718 и Raynor face/helmet. Эти три изображения
нельзя сравнивать пиксель в пиксель без одинакового времени, аспекта, фильтров и зависимостей.
Широкий кадр программы сам по себе не доказывает более правильную source camera.

### Что использовать и у кого доработать

Повторная проверка 15.10 на Arrival315000: original MCP-Codex `parsePreviewScene` и `actorAt`
выполнены на тех же сохранённых public Host bytes. После SC2→UVW basis conversion 14/16 authored
TRS совпадают точно. Raynor и Kerrigan отличаются: наш evaluator отключал целый property channel
из-за stale/non-monotone handles в раннем интервале, включая held endpoint после последнего ключа.
Это подтверждённая потеря ключей, а не основание для общего разворота моделей на90/180 градусов.

| Actor | Ошибочно оставленный base rotationZ | Последний authored key, native313954 | Позиция X,Y на native315000 |
| --- | --- | --- | --- |
| Raynor | -203.000259 | -183.718246 | 0.392052,4.941292 вместо0.477470,4.615700 |
| Kerrigan | -265.000061 | -205.184082 | 0.325188,4.375404 вместо0.112419,4.422310 |

Source3 fix landed907c0c03, parent9cb76d8b (exact source3+docs2, RELEASE NEW4(2)): existing evaluator проверяет raw controls только для запрошенного интервала;
existing `sampleChannel` возвращает точный interior key до controls. Глобальный отказ для плохих
time/value/order/duplicates/retiming сохранён; плохой queried interval не интерполируется. Steps
структурно правильного канала больше не теряются из-за curve handles. Independent37PASS/0skip,
новый тест на baseline даёт ожидаемый red; direct sampler4checksPASS. Полный cutscene.test snapshot
не квалифицирован из-за неполной shared closure. Patch/manifest:
C:/MODDING/parked/cutscenes/curve-admission-source3.*, SHAed02182c84058e2fb7b6eeea648aeb89c03cdfa98c2ba43b6b21d018196264ee.
Evidence: C:/MKTEMP/cutscene-{codex-comparison,curve-admission}-20261015/.
Дополнительный offline diagnostic PNG640x360 получен через existing world source→UI→Scene с тем же
сохранённым public Host model snapshot. Из16 активных ресурсов доступны15; ArmyRoomSet01 unresolved,
это не fresh MCP acceptance. Raynor/Kerrigan перемещаются по восстановленным ключам, но нужный
разворот лиц и свет не достигнуты. Не выдавать этот кадр за полный corrected native render.

Native floor follow-up: fresh public ContentSources payloads ArmyRoom00/07 содержат sequence2 GLstand
flags6, то есть native global flag установлен, name heuristic не нужен. BONE batching hits отсутствуют,
TRS у выбранных узлов static init: гипотеза потери их visibility не подтверждена. Existing sampler
показывает отличие Stand/GLstand только вalpha1.uvOffset; alpha/gain/emission unchanged. Current
SDK/UVM carrier не публикует clip-level alwaysPlays (Models owner подтвердил отсутствие реализации).
Whiteout AnimationDriver Bind и ClipPlaylist — reference semantics для owner review, не код для копии.
Сначала согласовать существующий/недостающий carrier Core/UV и nativeflag mapping Models; не имитировать
автозапуск через имяGLstand. Texture-channel-evidence после sceneTexturePixels даёт реальную alpha-mask,
а не fallback: FloorLineEmis alpha mean3.9149/255, Orange alpha255. Материалы остаются не исправлены.
Материалы/свет сравнивать отдельно от TRS. Reference GPU сохраняет per-property native refs,
CMS pass alpha, animated UV/brightness; добавляет global-loop layers и проверяет batchVisibility.
Это сценарии для существующих Models/Scene owners, не новая material library. Для orange floor
проверить активные batches/вариант и набор concurrent property layers до изменения emissive gain:
material unshaded/additive, поэтому добавление CLight само по себе пересвет не устраняет.
Reference поддерживает environment node curves, ambient cube и local/embedded lights; наш current
PNG включает только частичный directional rig. Подключение local-light transport остаётся приоритетом.
Число440 — все source light nodes в reference parser, не число активных native lights на315000.

Нельзя переносить без проверки: reference kernel интерпретирует curve type6 как Step, тогда как
наш corpus owner квалифицировал6 как Custom Bezier; reference GLstand detection содержит name
heuristic; local lights сортируются по camera-energy score и обрезаются до8/32; spotlight shader
использует cos(angle), хотя native evidence V6/V7 даёт cos(fullAngle/2). Эти приближения не являются
oracle. На данном проходе reference GPU с теми же assets/time/aspect не запускался; screenshot
Mission2237 не доказывает material/light parity Arrival315000.

| Наблюдение в reference | Применение в существующем Modkit owner | Доказательство результата |
| --- | --- | --- |
| kernel.ts:37–61 выбирает STC/STS membership и priority отдельно для каждого property; environment.ts:15–16 использует те же actor layers для CAM scalar refs | Q1/Q2: Models сохраняет native refs и ownership; общий sampler/scene применяет тот же набор слоёв к pose, lens, material и light. Не создавать второй sampler | Composed body+face regression: face без CAM/MAT каналов не стирает body; scene clock0 и layer1.489 дают согласованные pose/lens; затем actual Commu через Host |
| nativeBindings.ts:33–42 сопоставляет incoming M3A headers по animID с refs костей, материалов, CAM и LITE, сохраняет provenance | Q1: сверить с уже имеющейся M3A loader/header policy в Models; добавить лишь подтверждённые недостающие случаи | Scalar/vector/quaternion policies и STC membership проверить отдельно; revision и bundle hash в diagnostic receipt |
| nativeBindings.ts:44–77 сохраняет animated UV offset/angle/tiling, brightness/color и alpha отдельных composite passes | Q4: аудит existing M3 native→UVM material projection и scene material sampling; список каналов, не перенос material library | Подтверждённые DDS + полный material pass order/alpha на background и hologram; отсутствие nebula сначала разделить на unresolved model и shader/visibility gap |
| workspace.ts:49–59 собирает необходимые clip names до M3A expansion; ошибка optional DDS не убирает всю геометрию | Q0: existing Host companion admission и Models consumer. Использовать уже добавленный request.animationNames; для optional material resources согласовать partial result с отдельной diagnostic | Идентифицировать все16 objects и3 companion-budget failures; повторный actual MCP, без увеличения deadline и без похожих texture replacements |
| rigMetadata.ts:3–9 связывает turret groups с PATU forward matrix, angular limits/weights; lookAtStyles.ts:3 читает GameUIData styles; kernel.ts:91–114 меняет отдельные bones и повторно решает attachments | Q2: Models расширяет существующую metadata projection; Cutscenes разрешает native events/styles через existing Data/GameUIData route; общий pose solver применяет нейтральные ограничения | Проверить head/eyes/socket positions, ignoreEyes, time windows и deterministic seek на реальных моделях. buildTurrets уже существует, новый M3 parser не нужен |
| environment.ts и lighting/catalog.ts объединяют ActiveLight/EnvironmentLight, CLight preset, ambient cube, key/fill/back и embedded/local lights | Q4: общий CLight helper остаётся у Maps; Cutscenes передаёт свои nodes/events; Models — LITE refs; scene использует existing point/spot kernel | Проверить native type enums/units и light state, затем цвет/блики на reference1489. Не вводить параллельный catalog resolver или attenuation function |
| gpu.ts:39–40,106 использует GPU FBO+depth, secondary draw тем же renderer, reusable resources, per-sampler wrap | Q3: добавить passes/target leases существующему renderer, без отдельного WebGL player и RTT→CPU readback | Synthetic orientation/aspect + native Raynor portrait, resize/cleanup и random seek; CPU/WebGL ограничения отмечаются явно |

### Что в референсе ещё не подтверждено или требует исправления

- workspace.ts:60 сообщает engineValidated:false, materialParity:false, allSupported:false,
  nativeBlendEquationsValidated:false и facial parity:false. Названия тестов с Native не заменяют
  captured engine input/output. Property/camera/constraint tests в основном синтетические;
  RTT coordinates проверяет generated GLSL strings, sampler test использует mock WebGL.
- PNG snapshots используют отдельный software path: RTT/local lights/particles/ribbons/postprocess
  заявлены только в WebGL2 preview. Удачный browser screenshot не доказывает качество их MCP PNG.
  Наши публичные кадры должны идти через существующий общий scene route с явными capabilities.
- GPU RTT использует ping-pong previous-frame feedback. Для зависимости frame(t) от history нужен
  явный контракт/reset либо запрет/diagnostic циклов. Последовательное play и прямой seek в t должны
  давать одинаковый результат в поддерживаемом deterministic режиме. Target512 и camera aspect
  являются preview policy; native размер/аспект нельзя объявить доказанными по этой реализации.
- kernel.ts:74 при неразрешённой Director camera выбирает первую scene camera. Такой fallback
  скрывает ошибки. Приёмочный MCP должен сохранять native camera identity и диагностировать отказ.
- LookAt Rate читается в lookAtStyles.ts, но не применяется в просмотренном applyConstraints.
  Time/Weight ramps и порядок ограничений ещё требуют native проверки. Actor yaw не заменяет LookAt.
- Материалы/local lights интегрируются через string replacements shader source в gpu.ts и
  materialTextures.ts. Не переносить эту связь: использовать существующие scene material contracts.
  RTT V-flip проверять для нашего framebuffer/UV origin, а не применять ко всем DDS/UV безусловно.
- Asset fallback ищет ограниченную выборку CASC по basename, а собственное catalog inheritance
  упрощено. Эти пути не заменяют Host resource sessions и effective Data resolver Modkit.
- Original code имеет Attribution License; vendor/blizzard-models указан как GPL-2.0 в CREDITS.md.
  В рамках текущих AGENTS reference используется для evidence/spec/test scenarios; код не копируется.

### Ближайший порядок проверки

Уточнение по снимку reference и численной проверке1489: это reference renderer2237ticks,
а не игровой эталон. На его экране нет портрета Рейнора; сравнение с Editor1489 требует того же
времени/аспекта и полного resource context. Existing scene sampler на сохранённых actual Host
models даёт голову Рейнора внутри квадратного Commu frustum: NDC≈[-0.613,-0.191], depth≈0.4365;
шлем также внутри. Изолированный рендер Raynor-only той же камерой показывает бок брони.
Это сужает исследование до ориентации/pose/skin/покрытия, но не доказывает конкретную причину.
Diagnostic receipt: C:/MKTEMP/cutscene-fidelity-20261014/mission-head-camera-diagnostic.json;
PNG communicator-raynor/all-diagnostic используют малые сохранённые texture budgets и не являются
приёмочными кадрами. Commu native camera bone6 соответствует projected parent node-6, camera
child node-8 identity; Stand Work содержит7visibility channels и не содержит Camera TRS.
Pure actor Z270 имеет тот же знак в reference и нашем native→UVW mapping. Root twist, scale=.5
и подбор FOV не обоснованы. Reference уважает native FOV axis; у Models preview есть pinned
vertical policy, но ось не объясняет crop квадратного RTT. Bounded camera/root matrix проверка
согласована с объявленными node/TRS transforms (max difference<2.6e-8), двойная source-frame
поправка этим измерением не установлена. Diagnostic identity actor rotation показывает лицо,
но такой override не переносится в продукт без native semantics proof.

Для native semantics уже есть readonly SC2Editor1 recovered_cpp и SC2Editor2 canonical SQLite;
последний описывает Editor5.0.16.97563 и фиксирует EXE/DMP hashes/address domains в metadata.json.
В SC2Editor1 batch_174178_231904.c:433214 helper FUN_7ff7441e5d00 явно передаёт (z+90)*pi/180
в matrix builder; rotation vector и axis setters вызывают его (:436929–437005). Hash корпуса
CD12A2A500524D65F60E7960563C3FD63E3D8C60E54A391AA885BE0D745511EF совпадает с SHA256SUMS.
Readonly private Ghidra копия SC2Editor1 Program проверена существующим PseudoDisassembler,
без analysis/database writes: imagebase140000000, code RVA без runtime bias. Нельзя прибавлять
F00000 из другого address domain; здесь это попадает в .rdata. Из-за неверных nonreturn annotations
псевдокод фабрики обрывался после allocator; raw body3067b50 приводит к constructor30917c0.
Регистрация3086d80 подтверждает rotation vector/XYZ setters и offsets1a0/1a4/1a8. Descriptor306f8d0
называет CCutsceneNodeActor, parent30702e0 — CCutsceneNodeObject; Camera/Light siblings нельзя
считать тем же обработчиком. Base constructor3084dd0 задаёт storedXYZ0 и flag1dc=1; property string
3af2cc0 подтверждает useSceneRotation. Дополнительная ветка использует поворот сцены, не отдельного
связанного actor. Missing default=-90 не подтверждается и не добавляется. Тип Actor включает model
camera carrier, поэтому +90 также изменяет eye offset; resource/camera coordinate frames ещё требуют
согласования. Current installed Editor и immutable input SC2Editor2 не сопоставлены с этим Program.
Math helper3ed3a0, multiply3ecc90 и matrix→quat39dae0 подтверждают active Rx·Ry·Rz (Z затем Y затем X).
Существующий Cutscene world adapter исправлен для mixedXYZ; ActorState сохраняет прежний Rz·Ry·Rx
до отдельного доказательства. Проверка исходного world.test напрямую:14PASS/0skips, включая три basis
vectors и hidden model-camera carrier; это не native fidelity/eye-target proof. Narrow HEAD-based
commit candidate дополнительно:3selectedPASS,10excluded фильтром; hidden carrier проверяется existing
diagnostic, без зависимости от dirty opacity. Commit rotation slice
не включает ранее dirty RTT/opacity/animation selectors. Следующая проверка — native actor bearing
+90 вместе с camera/resource frame и useSceneRotation, затем fresh public MCP PNG/WebP.
M3/common renderer не получают глобальную SC2 facing policy; proprietary bodies не копируются.
Rotation source slice981cd3c1: fresh Host frame16objects, RTT identity unchanged; saved16-model
diagnostic PNG640x360 changes admitted mixedXYZ Void Skybox rotation, retains wrong Raynor portrait
and material/light response. Receipt mission-1489-rotation-order-diagnostic.json explicitly excludes
fresh MCP acquisition/native acceptance. Do not use this PNG to close Q3/Q5.

1. Q0: actual trace установил повторную пересборку oversized layer tables в SC2 ModContext.locate.
   Private ModData point-metadata slice переиспользует membership из readListed, без нового cache:
   111→9 table loads, 106→4 oversized loads, одинаковые32locates, byte-identical Commu UVM.
   Время23.978→0.308s — наблюдение последовательных прогонов, не controlled benchmark.
   Fresh public MCP Mission1489 теперь16/16models, без companion deadline failures, но кадр перекрыт
   декорацией. Q0 admission подтверждён для private route; owner landing/typecheck ещё не закрыты.
   Patch parked/blizzard-formats/mod-metadata-point/mod-owner.patch (4sources+existing owner test),
   apply--check PASS; live ModData не менялся.9independent equivalence +14Vitest assertions PASS.
2. Q1/Q2: закрыть общий clock для composed pose и CAM scalar lens. Структурный дефект найден:
   layer time используется для bone pose, тогда как lens получает world time0 и теряет sequenceIndex.
   Actual Commu UVM теперь получен: Stand Work camera pose/lens одинаковы на0/1489/2237,
   camera0 HFOV0.7610128, near0.01, far10. Поэтому этот clock defect не установлен как причина crop;
   не править FOV под картинку. Picking и per-object raster выявили CPU Bridge00 occlusion: private
   комплект не содержал уже существующего обычного perspective clipping. Подключён existing owner
   source (7independent tests); также восстановлен RTT forwarding, потерянный frozen world compile.
   Camera clock bridge перебазирован четырьмя scoped hunks,16tests PASS. Это mixed owner private
   integration, не clean release. Public PNG1489 теперь показывает nebula/RTT, но15/16 из-за отмены
   Artanis acquisition; body crop остаётся. Public catalog проверка ScaleMin/ScaleMax уже получена:
   Raynor/Commu/Artanis/RaynorSet имеют min=max=[1,1,1] в VoidStory closure. Отсутствие этой проекции
   не объясняет crop здесь; .5 не добавлять. Проверить actual head/helmet pose vs model-camera frame
   и native bearing construction/registration; Paiur04 effective context ещё не сопоставлен с
   игровым reference. Public ContentSources list/files не нашёл native Paiur04 в установленном
   Campaigns/Void closure, installation Maps и Maps cache; custom cached Epilogue не заменяет его.
3. Q3: квалифицировать actual Commu camera index/basis/lens и RTT aspect, затем портрет на1489/2237.
   Native trace15.10: actor+0x230 возвращает имя камеры;1d5a630 только bind model/index.
   Actual frame1d5cb50→bone1d456e0→owner1d4e5e0, root bone parent=model instance owner.
   Поэтому camera matrix включает placement; model-space exception не добавлять. Unit bearing
   +90 из Actor helper не доказан как final M3 root rotation. Public MCP эксперимент с literal+90
   на Arrival315000 дал16/16models, но декорация перекрыла камеру; эксперимент source/test/private
   JS восстановлены до committed Euler981cd3c1 + prior owned overlays. Failed PNG не приёмка.
   Цепочка44c220→44c020→285c430 установлена для PreviewerModel: public Host подтверждает
   CActorModel, raw registrar1c5b30→ctor281a2f0/280f190→vptr38f3118. +300/2869aa0 и fallback
   +2f8/2836160→2869c00 сохраняют quaternion без поправки; +308/44a4a0 false. Derived +548
   передаёт позу в model setter1d45280, no-parent quat копируется в instance+50. Root/owner
   matrix update1d456e0/1d4e5e0 использует TRS1d3e450→65c890. Это частичное static evidence,
   не вся initialization/hosting/animation/render semantics и не installed-build parity.
   Следующий trace — полный actor/M3A/camera frame; camera inverse/scale не подбирать.
   Проверка Models15.10: UVM node0/58/60/61 по name и skeleton.boneIndex соответствуют raw
   BONE0/45/47/48 (pelvis/helmet/neck/head). Предварительные raw/loader V1 с индексами58/60/61
   отозваны; использовать raynor-raw-bones-20261015-v2.json и raynor-loader-scope-20261015-v2.json.
   В raynor-quaternion-intervals-20261015.json проверено170intervals Stand3/Talk05:12:
   min raw dot.9997015086, отрицательных0, поэтому нет discriminator для trig-slerp branch.
   На actual Stand1.489/Talk05.812 native-format evaluator и UVM совпадают до5.552e-17;
   это согласованность двух путей Modkit, не доказательство игрового результата. В8tracks нет
   STC conflict; приоритеты/weighted mixing этой выборкой не проверены. Не менять quaternion
   policy ради портрета без дополнительного evidence. Следующая проверка — attachment и channel
   coverage при совместных Talk05+Stand существующим composed-pose owner, с сохранением input SHA.
   Composed audit выполнен: raynor-composed-layer-evidence-20261015.json.270/270каналов выбирают
   Talk05, posed geometry всех10частей совпадает с single Talk. Это не независимый native oracle.
   Найден конкретный следующий discriminator: public-read исходник Mission SHA248e45794b6d08d479bf6c8e064ea66a720bdb0dd2fbe9f6502637088ab06094,
   line113 задаёт Talk05 start677/duration1056/blendTime500/blendOutTime450. На1489ms до конца244ms,
   но public frame передаёт только name/time/priority без authored transition parameters. Line89
   содержит Artanis Talk03 weight.5 и blendTime1000. Сначала подтвердить native blend envelope,
   затем передать authored schedule через существующий animation-layer contract и единственный
   composed-pose owner; новый SC2-only sampler не создавать. Не объявлять exact weight/native pose
   подтверждёнными по одному XML. Receipt raynor-authored-blend-schedule-20261015.json в fidelity root.
   Native уточнение: editor-native-project/cutscene-anim-blend-evidence.json подтверждает field bindings
   blendTime→+f4/blendOutTime→+f8; dispatch30815c0 прибавляет +f8 к своей верхней границе.
   Новый cutscene-anim-interval-bound-evidence.json квалифицировал ctor/vtable и XML bindings:
   +108 читает start(c8), +118 читает duration(cc), +e8 false. Для этого static object path interval
   admission=[start,start+duration+blendOutTime); Talk05[677,2183). Raw V6 window3081bd0:900 подтверждает command release после elapsed>duration:
   max(0,1-(elapsed-duration)/blendOutTime)*authoredWeight с f32 округлениями. На1489 command=1;
   final pose blend-in/controller mixing остаются не квалифицированы. Это static imported image,
   не native execution. Добавлена derived animationLayers в existing evaluator, без изменений
   authored activeClips/timeline/resource clips. V2 signed-int32 guards отклоняют derived commands
   для дробных/переполненных clocks с diagnostic; исходное время/state сохраняются. Не floor-ить.
   Formats actual ACK:35tests/0skips; evaluator closure types0, independent HEAD differential10times.
   Full project types сохраняют known foreign dependency errors; green full build не заявляется.
   Public Host V2 proof: Mission1489=1/1733release1/1958=.5/2183absent, Artanis17000=.5,
   fractional1958.5 diagnostic. Receipt C:/MKTEMP/cutscene-native-transition-20261015/public-host-receipt-v3.json.
   Private runtime-v3 имя не означает semantics V3; compiled только evaluator с V2 SHA2496af98…,
   frozen dependencies, временный junction в MKTEMP recorded. World/SDK wiring ещё не реализован.
   Свежий public Host case17000: native active Talk03 у Master_Artanis имеет weight.5/priority5,
   world packet содержит только Standpriority3 и animation-weight-unsupported. Receipt
   artanis-weight-public-host-receipt.json фиксирует scene/frame/resources и compiled-owner SHA.
   Это обязательный реальный fractional regression case для generic layer implementation после
   Core contract/source decision. Проверить переходы до/после clip end и random seek; точную
   native envelope/pose дополнительно квалифицировать, частичный тест не закрывает Q1/Q2.
   Reuse finder: Core уже имеет createModelPoseBlendSampler и SequencePoseSampler.sampleBlendedPose,
   scene poseSamples потребляет skin/node pose. Не дублировать TRS/quaternion math. Singleweight.5
   нормализуется до1, поэтому определить residual base и per-channel sparse semantics до wiring;
   missing channel→rest в существующем poseSamples нельзя молча применить к Eyes/body overlays.
   SDK world layers currently full-weight; расширение existing sparse owner/contract — Core decision,
   omitted weight сохраняет прежний результат. UVM/model facet blendIn/OutSeconds metadata уже есть.
   Independent Whiteout original evaluator run выполнен с pinned WhiteoutLib f3e57087…:
   C:/MKTEMP/raynor-whiteout-ref-20261015/whiteout-raynor-reference-execution-20261015.json,
   SHAfb5f87b9…. Stand1489 max world/skin/posed delta5.96054e-6/5.85938e-6/1.04398e-4;
   Talk05 elapsed812:4.66110e-5/4.72534e-5/2.52572e-5. Original Load/Attach/Evaluate/SkinVertices,
   четыре name-mapped bones/10 unique regions, без копии sampler. Feasibility blocker superseded.
   Это single-clip reference comparison; camera/controller/native visual parity ещё не проверены.
   Receipt actor-model-publication-evidence.json сохраняет13input hashes. В saved Raynor root,
   helmet/neck/head rotation channels заданы явно: missing-channel→identity не подтверждён.
   Найден context ctor3063c80; angle приходит шестым аргументом. Raw whole-function decode трёх
   creation paths893eb0/108adf0/108caf0 подтверждает angle0, а не default -90. Не переносить этот
   частный факт на все callers и не считать найденным final unit→M3 orientation.
4. Q2/Q4: передать ActiveLight через существующий WorldSceneFrame и общий lighting facet.
   Реализован exact SDK/UI source slice, Core commit addc1d28: clean HEAD patch без старых RTT/opacity
   WIP,58tests/strict PASS, independent Integrator60PASS с его regressions. Один canonical bounded
   snapshot helper, без второго renderer/cache/CLight parser. Это generic bridge, не SC2 adapter.
   Затем SC2 Maps shared catalog-light projection и SC2-only ActiveShot/clip/attachment semantics.
   Public Host315000 Arrival: SMX2CutsceneEpilogue01Arrival,53authored lights, ambient blue
   [.047059,.121569,.380392], directional intensities[.164,.047,0]. Mission1489/2237:
   SMX2CutsceneMissionEpilogue01,48authored lights, ambient black и global diffuse[0,0,0].
   Для Mission локальные point/spot lights обязательны; global rig сам по себе не даст fidelity.
   Не считать все authored lights активными, не подменять их directionals. Reuse existing generic
   SceneRendererLight owner; текущий world rig его local path ещё не публикует.
   A geometry owner уже committed c92395e3: sampleLightGeometry/LIGHT_GEOMETRY_GLSL отделены от
   прежней preview floor/clamp/average policy.8direct scene tests,10000CPU cases и25actual Intel
   ANGLE WebGL2 cases before/after совпали; Scene port-strict before/after PASS через fresh pinned
   SDK/Core declarations. Receipt C:/MKTEMP/pointspot-math-20261015/qualification.json. Это не M3 BRDF.
   B local material response реализован только в isolated candidate
   C:/MKTEMP/cutscene-standard-local-rebased-20261015/source на bd79296f; historical private B; итоговый corrected13 source landed Coreff96f6e2.
   Existing standard BRDF повторяет direct
   diffuse/specular, однократные ambient/environment/emissive/alpha и key-only shadow сохраняются.
   Explicit default-off geometry-needed flag в existing material-geometry owner должен дать true
   scene-world position/TBN всем standard paths; materialWorld/worldToMaterial coordinates для
   point/spot range не использовать. Environment/worldShading semantic flags не подменять.
   Приёмка B: CPU+GPU tangent/object/blended normal maps, mirrored nonuniform/skin/instance,
   nonidentity worldToMaterial, cone/specular и отсутствие изменений directional-only кадров.
   Separate mirror/twoSided fix уже committed bd79296f: flat MODEL sign корректирует facing
   один раз, CULL-disabled/restore явно CCW. Baseline102LSB/state-order failure reproduced,
   37Node/strict0/5+11actualGPU cases PASS; CPU true-backface policy не менялся.
   Receipts C:/MKTEMP/scene-mirror-facing-20261015; shared dist не менялся.
   Final private B:7production+4existingtests, independent39Node/strict0 PASS; earlier unchanged
   kernel6/TS9 PASS,0skips.30GPU cases:29standard +1PBR preservation control. Raw premultiplied
   RGB<=1LSB, alpha exact, straight RGB bound ceil(255/alpha) доказан readback captures; alpha128
   даёт2LSB также на legacy directional. PBR46LSB — existing CPU/GPU mismatch: independently
   rebuilt committedbd792 CPUbefore=after иGPUbefore=after exact; не заявлять PBR parity.
   Baseline5controls exact; zero-distance проверен центральным пикселем17x17, fresnel включён.
   Retained11GPU pairs exact0: sameobject rig mutation/removal/restore, mixedsign instances,
   positive rotating skeleton tangent/signed/object через existing sampler/deformed owner.
   POST выявил sameobject removal stale frame (121LSB); исправлен previous-spatial guard и
   added registered regression. FINAL independent gate/POST audit PASS,0GLerrors/0livehandles.
   Existing sweep evicts unused variants (toggle2→4 links), value changes не компилируют шейдер;
   нового retention cache нет. Negative-deforming skin/native acceptance вне qualification.
   Core actual11file review обнаружил P2 подготовки: browser auto sceneLighting меняет omitted/
   empty-context PBR/unshaded. Старые explicit-context controls не закрывают его. Новые24GPU
   before/after cases reproduced12failures8PBR/5unshadedLSB (single/mixed/composite).
   Отдельный repair proposal C:/MKTEMP/cutscene-light-preparation-repair-20261015:13SHA,
   8production+5existingtests, existing typed per-pass adoption вместо глобального force.
   Independent61Node/strict0/24protectedCPU/GPU max0; lit standard auto==true и differsfalse112.
   Оригинальный frozen11 сохранён. autoSceneLighting расширяет exported package API, хотя SDK/
   raw schema неизменны. Core explicit API design ACK получен, PBR/unshaded P2 закрыт
   для reviewed repair; Core independent61Scene+6kernel PASS. Integration HOLD позднее снят (ff96f6e2); требовалась private
   integration с текущим RTT в standard-program.ts, headless.ts и render/materials.ts.
   Копия C:/MKTEMP/cutscene-B-live-integration-20261015 сохраняет три foreign RTT delta;
   context conflict объединён сохранением обоих полей. Node61+kernel6+9TS PASS, port-strict0; changed lines всех трёх foreign RTT delta
   сохранены точно, final private receipt готов. Final B-only patch/13SHA, Core exact-hunk GO и landingff96f6e2 выполнены.
   C additive world/SDK locals — отдельно после B. Maps подтвердил: shared helper/strict-TS owner
   projection/pending patch/commit пока нет; existing map projection только static ambient/directional
   и tone mapping. Extraction не добавит native local position/fade/cone/clock автоматически.
   Maps остаётся владельцем единственной проекции; local fields/active48/53 — отдельный точный scope.
   B qualified budget4 не означает поддержку48/53: beyond-budget refusal, без nearestN/truncation.
   B source GO и landingff96f6e2 выполнены; C/local projection требует отдельного GO, чужой CLight helper не писать.
   Источник: public Host scene-at + ContentSources openModContext data.entities; MCP JSON sample
   capped, JSON retainOutput отказан. Полные receipts/context-light-evidence.json в MKTEMP.
   Bone LookAt, material animation и полный background resource closure остаются отдельными задачами.
5. Q5: PNG1489 с native reference и WebP с тем же source camera/полным набором объектов. Новый
   PNG1489 admission16/16 был перекрыт CPU clipping bug. После подключения existing clipping/RTT
   public PNG15/16 показывает сцену, но один model request отменён и материалы/свет/портрет неверны.
   Предыдущие PNG и короткий Arrival WebP также diagnostic artifacts. Полнота моделей не доказывает
   fidelity; acceptance всей цели не достигнута. Новый Arrival WebP480x270/8frames/4fps/2s отменён
   по180s во время подачи CPU кадров. Сначала измерить стоимость существующего common renderer;
   не обходить лимит накоплением raw movie и не вводить второй encoder. Media backend отдельно
   квалифицирован на3RGBframes/5fps: GIF/WebP/OGV декодируются в правильном порядке/по200ms.
   StrictTS owner slice16paths принят Core/Integrator и committed23883870; receipts в
   C:/MKTEMP/cutscene-media-typed-20261015. Исправлены borrowed-buffer/early-exit0 гонки,
   9encoder+3decoder tests PASS/0skips. Это media scope,
   без RTT/scene/Three closure и без full Core build/release/native fidelity заявления.
   Array-free bilinear private experiment дал identical RGBA, но не стабильное ускорение:
   отклонён, original private sampler восстановлен. Следующий performance proposal — sampled-pass
   invariant preparation в существующем compilePass, без нового cache/shader/renderer.
