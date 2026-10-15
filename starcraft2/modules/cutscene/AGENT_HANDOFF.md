# Handoff: SC2 Cutscenes foundation и fidelity

Обновлено: 15.10.2026. Сессия MODKIT-CUTSCENES, [Blizzard] Formats.
Активная цель пользователя: реализовать FIDELITY_PLAN, приёмка — PNG на Artanis018 в
Epilogue01Arrival и анимированный WebP для проверки. Приёмка остаётся открытой, пока требуемая
реализация и новые артефакты не готовы. Старый diagnostic PNG не закрывает эту приёмку.

## Текущий результат 15.10

Native bearing, новая квалификация 15.10: native-default-evidence.json в
C:/MKTEMP/cutscene-native-bearing-20261015 подтверждает schema default rotation=[0,0,-90]
и rotationZ=-90: RVA308805d/3088380, имена rotation/rotationZ независимо прочитаны
readOnly Ghidra по36b6a20/352e998, offsets1a0/1a8 и setters308dc80/308dda0 совпадают с actor helper.
CtorXYZ0 не является effective schema default. Existing helper3085d00 добавляет90 передRxRyRz.
Подготовлен PRIVATE source2: только native nonempty modelLink, после evaluated axis curves;
omittedZ=-90, explicit0 сохраняется, raw modelPath/ActorState без изменений. Общая quaternion math,
asset UVM, native writer и внешняя useSceneRotation context не меняются. Source2-own.patch и
source2-manifest.json фиксируют cleanHEAD+own и live+foreignRTT варианты; shared source пока не менялся.
Диагностика arrival-315000-bearing-diagnostic.png640x360 использует actual candidate adapter +907
curve evaluator, saved Host15/16, прежние camera/light/textures. Меняется только5 rotation; position,
scale/camera/light сохранены. Facing изменился, но floor/light ещё неверны; это не public MCP
и не native visual acceptance. Final bearing gate: clean slice16PASS/0skip, livecandidate17PASS/0skip; same3new cleanBASE3FAIL.
Ранее clean run15PASS/1FAIL зависел от foreign opacity; убрана только эта unrelated assertion,
rotation/camera checks сохранены, failurelog сохранён. Other imports actual repo; не fullcleanclosure.
Owner GO фиксировать перед посадкой, не считать
наличие private proposal разрешением shared build. Отдельный REF defect исправляет Models:
ArmyRoom00 MATM10/13 pass1 normal-as-color; designB сохраняет identity/потери и явно отказывает
unsupported fresh write/standalone REF, full native reflection rendering пока отсутствует.

Повторное сравнение MCP-Codex выявило реальный curve admission defect: whole-channel invalidControls
отключал6 transform channels Raynor/Kerrigan наArrival315000. Native lastkeys313954 дают yaw
-183.718246/-205.184082 вместоbase -203.000259/-265.000061, также меняютpositionXY. Original reference
parsePreviewScene/actorAt выполнены на actual saved source;14other authoredTRS exact afterbasis.
Source3 landed907c0c0338942a49c958d4c843bd10f2ef17893d (parent9cb76d8b); existing evaluate.ts/curves.ts/evaluate.test.ts исправляет interval-local controls
иexactinteriorkeys, сохраняет global malformed/retimed refusal.37testsPASS/0skip, baseline newtestred,
sampler4checksPASS, PRE/POSTauditPASS. Full cutscene.test snapshot closure incomplete; no fullsuitegreen.
Patch parked/cutscenes/curve-admission-source3.patch SHAed02182c84058e2fb7b6eeea648aeb89c03cdfa98c2ba43b6b21d018196264ee;
manifest/actual endpointproof C:/MKTEMP/cutscene-curve-admission-20261015/. Exact5commit/source3+docs2, finalindexempty, RELEASE confirmed NEW4(2). Foreign6574 preserved; external Runtime-test transition87ec838b→3e572e19 explicitly acknowledged, nottotal0drift. Receipt source5-commit-receipt.json.
Offline diagnostic arrival-315000-curve-diagnostic.png640x360 использует existing world/UI/Scene и
saved public Host models15/16 (ArmyRoomSet01 unresolved). Это не updated MCP acceptance; facing/light
remain incorrect. Existing private CLight lightingClips return preserved only in runtime overlay.
Reference caveats newly pinned: type6 treatedasStep, GLstand nameheuristic, top8/32 lights truncation,
spot shader cos(angle) vs nativecos(fullAngle/2). No code copied; primary Whiteout/native unchanged.
Current Integrator NEW4(2): thread01a13e7a-9001-76f0-b5ff-a0e8c3ca8b3e; exact5 window completed and RELEASE accepted. Docs4b17443b RELEASE accepted; current native-bearing source request pending, no build reservation.

New native floor proof: C:/MKTEMP/cutscene-batch-layers-20261015/native-batch-evidence.json,
public ContentSources→existing Models reader, ArmyRoom07 SHAab98a7444d22dbcf8acbe7b8800b3f9052267317a4013512c08d4cdea96f91d1.
ArmyRoom00/07 seq2GLstand flags6; no BONE batching hits, TRS allinit, so geometry/visibility failure
notestablished. Existing material sampler proves onlyalpha1uvOffset differs Stand/GLstand, notCMSalpha
orgain. Whiteout globalplaylist usesalwaysPlays; currentSDK/UVM globalclipmetadata absent (Modelsowner
confirmed). Core question sendfailed idle; Modelsowner ACK no implementationinflight. No globalname
heuristic ornewcontracts introduced. Actual compressed DDS decoded byexisting sceneTexturePixels:
FloorLineEmis alpha mean3.9149/255, Orange alpha255; notemptyfallback. Initial zero-rgba probe was
invalid because compressed descriptor intentionally hasrgbaempty; corrected evidence uses65536bytes.
Reference readM3Rig hasno batches; attemptedbatch comparison insufficient, no geometryparity claim.
No further source/index/build reservation; nextwork globalmetadata ownerdecision + primitive/drawtrace.
Commander-specific Whiteout proof nowexists (not Marine reuse): C:/MKTEMP/arrival-character-native-20261015/
commander-whiteout-comparison.json SHA63b65271246f75acf75fa27750d8c01dfbc7d9c23120cbcc3d4ca3e0744cc1ba;
commander-driver-receipt.json pins driver/WASM/reused originalreference libs. ExactpublicContentSources
M3+7M3A merged savedbindingorder, originalM3adapter Evaluate+SkinningSystem, Stand explicit4158ms.
170bones/13geosets matched; maxworlddelta.075793 (rightfingerTips), pelvis.000348784/chest.000651799/
head.005279176; maxfixedvertexdelta.001171514. No90/180modelrootdefect established, notnativeactorbearing
orclock/renderacceptance. Native315000→phase4158 derived4934duration; referenceclocknottested.
Onlyroot/pose/skinreference consistency isshown; nativegaze/cutsceneconstraints remainopen.
CoreModels activecontact01a13b7e-8ba6-70e0-b5a5-9a6e1aeceff9 andUV01a0c574-f924-70b1-b7e7-c0d1bf71a7e0
confirm noalwaysactivecarrier; sharedR2 queue/postM1, noimplementationGO. Core/Models informedexact
Commander numericlimits. NativeAlwaysGlobal flagbit2 interpretation pinnedsourceonly, see Modelsreceipt
C:/MKTEMP/m3-global-sequence-source-20261015/source-evidence.json; priority/concurrentclocknotnativeoracle.
Genericmaterialcontrast persisted material-sequence-contrast.json SHAc82d735a943ee75c266256397c66c5aa2acd549efcdba514efdc7f68fe7e7783.
Docs2V7 landed6d11c44989f27575cbbcf0fc2aa133399cc95ef4 parent385a08f9, exact2/indexempty/foreign6574preserved,
RELEASE sent. This Commander update ishandoff-only unstaged, no source/buildreservation. Next concrete
probe: nativeActor bearing→finalmodelbasis and exactnativeproperty AnimRef→STC/SD lane precedence;
noGLnameheuristic, arbitraryrotation, brightnessboost orsecond scheduler.
Native transition projection landed Blizzard80068da2 (exact source2+own2docs). Public Host V2
proof PASS,35directtests/closuretypes0/HEAD differential10times; world pose mixing пока не wired.
Core local standard lighting landed ff96f6e2a6870af4147f409d97670df3ebf1ebab (exact13 clean own
index blobs, parent13819153), NEW4 window RELEASE. Все3foreign RTT live hunks сохранены побайтно,
indexempty; no shared dist/vendor/acceptance. Независимый и повторный live-byte-private gate:
61Node+6kernel+9TS=76PASS/0skips, port-strict0. Receipts C:/MKTEMP/cutscene-B-live-integration-20261015/
B-commit-receipt.json, live-byte-check-receipt.json, independent-integration-receipt.json.
Это 4-light generic material qualification; native SC2 local-light projection/active48/53 ещё нет.

Новый подтверждённый PRIVATE clock fix: C:/MKTEMP/cutscene-material-clock-20261015. Existing
world selection cache сохраняет исходный single layer отдельно от TRS composition. Material clock,
sequence index/duration/loop доходят до existing sampler; pose/camera/effect clocks не меняются.
Ровно1authored+1resolved layer; multi-layer material semantics не придумываются. Exact2 source/test
patch9a96ac5b0c77d27415d155ccb285c6f8cdeb904e1af18f5fffb1697f602bfcc2 также parked/cutscenes/.
gitapplycheck currentlive PASS, но live/Core source не менялся. Runtimefunctions baseline сверены,
RTT wrapper сохранён. Independent23PASS/0skip (clock7,camera9,RTT6,BodyUpper pose1); тот же fixture
на old runtime даёт4PASS/3FAIL. Actual saved floor plan: alpha1 UV offset [0,-1]→[0,-.5541189333623855],
geometry и camera hashes неизменны (floor-clock-comparison-receipt.json). POST preservation audit PASS.
Это исправление clock propagation, не native pixel acceptance. Новый PNG ПОСЛЕ fix получен через installed-game Host/MCP: 1280x720,315000ms,16/16models,
SHA95639d2650845b3b6627d174df16ee81ce9ad80b9f5d76f585e8fd1b51b27452. WebP PASS: arrival-artanis018.webp,256x144,2fps,4unique frames/2000ms,16of16models; SHA588ad2448c99f3fa0180f5c8a0927cd1c5b00ac8b2b033058183a5fc1a447040. Ранний MCP import build-process оборвался System.OutOfMemoryException при свободной
virtualmemory~989MB/physical~556MB. Последующий standalone MCP import с heap512 PASS/RSS138MB;
память освободилась до11GB, fresh installed-game MCP PNG/WebP завершён09:19:49UTC (run88810 exit0).
Bounded baseline/proposal type overlay: одинаковые70diagnostics, world0/new0, все649inputs SHA-exact.
Это SAME LIVE differential, общий Core/SDK остаётся красным. PNG RGB delta среднее[.026,.048,.078]:
clock effect мал; пересвет пола, тёмные персонажи и facing Raynor остаются. Готовый runtime:
material-clock-20261015/runtime; предыдущие PNG/WebP ниже предшествуют fix.

Commu camera reference теперь выполнен: оригинальный WhiteoutFlakes Evaluate учитывает raw bone6,
несмотря на отсутствие mesh weights; generic matrix после удаления явного externalframe отличается
на2.53761e-8 на default/StandWork0/1489/2237. Raw lens metadata/no selectedtracks подтверждены.
Receipt C:/MKTEMP/raynor-whiteout-ref-20261015/whiteout-communicator-reference-execution-20261015.json
SHA9233138b7f79a87750ff3a0ee3bb9d4b65be152b2a33a4ba0f1fe38dfb79eb3e.
В originalFlakes нет optical-camera Evaluate API: полная projection/basis/RTT framing ещё не oracle.
Причина portrait crop не установлена. Не вводить поправку +90 или FOV ради визуального совпадения.

Weighted sparse pose: PRIVATE V2 в C:/MKTEMP/cutscene-weighted-proposal-v2-20261015,
patch SHA317ff36de10209ac8bc0a370a3a371b88b584f60c6c37d83cb2adbe7afbed2b8.
20directPASS/0skip, strict closure0,14saved-resource legacy cases JSON-exact. Fresh public Host
Artanis Stand642/Talk03417: fractional overlay retains225 lower channels exactly. Aggregate retained
entry budgets, full-weight pruning, content-derived rest identity проверены red mutation; это не
предел peak heap и не oracle native controller/blend-in. Core actual V2 review завершён: blockers0,
независимо20testsPASS. Решение первого API slice — без четвёртого rest/base аргумента. PRIVATE V3
C:/MKTEMP/cutscene-weighted-proposal-v3-20261015:19tests/strict0,14legacy exact, Artanis225lower
unchanged; patch8eeea8d274873ca3f048a7f89fb4c5e3d584bdca3cd52f72c85bca02747c6429.
SDK/world/source GO отсутствует. V2 сохранён неизменным; V3 не подключён к PNG.
Finder: frame ABI generic kind:value, отдельного Host semantic layer admission нет; MCP/UI сохраняют
objects, Scene worldModelAnimation теряет weight при selective construction. Предложен exact6
SDK carrier/helper/Scene +3focused tests; UVW layers по-прежнему отказаны. Core ACK ожидается.

Maps shared CLight source landed16bc7f15b67decc3950acdcf6bf3546165485c7f. Cutscenes consumer PRIVATE:
C:/MKTEMP/cutscene-clight-consumer-20261015, parked/clight-consumer-source3.patch,
SHA05d79d2304ef8002ec354a0132c860122f3d4f3088017597b9ba0832d0e0075b.
25focused tests; offline integration на ранее public-Host bytes/entities даёт lighting для Arrival315000
и Mission1489/2237,16objects и MissionRTT request сохранены. Не fresh Host/render proof.
Core POLICY ACK: partial lighting facet/itemCount0 относится к STATIC page; explicit frame-only reason,
page unsupported; sampled rig заменяет целиком, omission возвращает empty static baseline. Directional
profile3, без усечения. Inline/transition/multiToD/local lights отказаны адресно. Existing pending
resource promise сохраняет first-caller cancellation; concurrent callers fail вместе, следующий retry
проверен. Strict attempt пока не зелёный:66 diagnostics только в чужом Core SDK maps/registry;
independent final25PASS и baseline differential:66=66 structural-equal,0new относительно SAME LIVE
original3. Это не clean HEAD: Core SDK maps имеет foreign15lines RTT/opacity WIP, registry clean.
Receipt independent-consumer-v2-receipt.json; общий/Core typecheck зелёным не объявляется. Dist/pack ещё
не обновлён; Maps просит дождаться Integrator pickup до live import. Consumer live source НЕ менялся.

NEW4 дал отдельный PRIVATE compile/import + saved-public Host frames GO, без render/capture.
Свежий C:/MKTEMP/cutscene-clight-host-20261015: codec bundle e25da6af13f5bb7cb220ff99289c5fb3717d3d4f1b1f29ed406ed5232da1bafc,
реальный JS CLight bridge импортируется. Public createHostMcpPort → worker → world source.frame
прошёл на сохранённых Arrival315000/Mission1489/2237:16objects/3directional, MissionRTT1.
Fixture использует ранее полученные public ModContext entities через стандартный injected
ContentSources seam; unexpected game I/O0, contextsDisposed2/sourcesDisposed1. Это не fresh game
catalog/assets и не PNG/WebP. Receipts compile-import-receipt.json/public-host-frames-receipt.json
фиксируют compiler inputs/metafile/output hashes, actual SDK source binding с retained15WIP,
прочие публичные пакеты из прежнего frozen diagnostic profile. UI frame-light bridge старого
профиля не содержит нового override: render phase требует отдельного compiled closure, не
заявлять lighting pixel effect из Host frames. No shared dist/vendor/production pack.
Независимый повтор Host runner exit0: independent-public-host-receipt.json. Из 16 compile inputs
все SHA совпали, live own3 unchanged; две format-writer-unresolved диагностики не являются writer
приёмкой. Финальное сообщение NEW4 с proof не доставлено: tool Cannot steer without active turn id.
Прямое последующее «приступай» пользователя разрешило отдельную private bridge/render проверку;
stage/live/shared build GO из этого не следует. Own2docs обновлены, предыдущие own-docs2 SHA
superseded; перед stage нужны новый manifest и точное интеграционное окно.

Private C:/MKTEMP/cutscene-lit-render-v2-20261015 собрал существующий committed UI lighting bridge
с retained RTT строкой и SDK maps (retained15WIP); frozen Scene/Host/codec-kit остаются прежними.
compile-receipt.json фиксирует SHA и все временные node_modules junctions. Никакой shared dist.
Независимый before/after3frame boundary PASS: objects/resources/camera/animation time/RTT unchanged,
lighting override/omission стабильны. Реальный public MCP+installed ContentSources дал PNG
arrival-315000.png,1280x720,1102800bytes,models16/16 (08:01:14UTC). Visual review: Raynor спиной,
персонажи тёмные, пол ярко-оранжевый; native fidelity НЕ достигнута. Старый Scene профиль не включает
новые committed ff96 material changes/e66f gain; нельзя считать этот PNG проверкой их эффекта.
WebP480x270/3fps/2s отказан: ffmpeg180000ms, render-receipt.json сохраняет ошибку и успешный PNG.
Меньший public MCP WebP arrival-artanis018-small.webp256x144/1fps/2s получен:13270bytes,
SHA99032564feaeb9c9caa36c4f68c15590c47d2d6ade17eb7919342c5342383383. Pillow реально декодировал
2разныхRGBA кадра, по1000ms; small-animation-decoded-receipt.json. Models15/16: model:395714
operationcancelled. Не полная сцена/не visual acceptance, исходный PNG имеет16/16.

Попытка current-render (B source+e66f,30bundledexports) прошла source65unique tests/0skip и input/output
hashes, но actual MCP import отказал: renderWorldHeadlessFrame отсутствует в этом source snapshot.
Этот профиль НЕ использовать для рендера. Frozen dist содержит поздний RTT WIP, которого нет в
frozen/B source; bundled replacement всей Scene теряет его. Нельзя считать source gate product proof.
Исправленный fresh C:/MKTEMP/cutscene-material-leaves-20261015 сохраняет весь frozen world dist
побайтно и transform-only обновляет11existing material leaves (B9, e66f gain2). Новый private
codec-kit содержит один standard-material-glsl owner leaf; остальные зависимости frozen.
Actual MCP static import PASS, прежний RTT entry экспортируется. PresentationRotation world hunk
здесь не включён; это material-only build. Actual runtime gate первоначально нашёл потерю RTT-only
validation в render-model при e66f overlay. Восстановлен точный existing frozen/live RTT hunk;
sourceSHAafe249b890d5653e1e5be6e6a9f09ec808c4dc39662e7d90d382d192b91ccdb5. Повтор без изменения
tests: materials26+RTT6=32PASS/0skip, включая secondary world pixels. Independent-gate-receipt-v2.json;
предыдущие failure receipts сохранены. Один physical shader leaf, frozen world3 SHA неизменны.
Fresh public MCP PNG315000 получен08:34:26UTC,1280x720/16of16models/1102800bytes. SHA
86911dc46418e64678780e404535937b1dfb8e486af2667510fd55f611ce2360 совпал с lighting-only PNG;
Pillow RGB difference=0. Улучшения картинки от этих material leaves на данном кадре нет.
png-comparison-receipt.json фиксирует это; import/tests PASS не означают native pixel improvement.

Actual saved material evidence: floor-material-evidence.json, source arrival-prepared.binSHA
5bbeb3155352038b4c1d2470145b3f54aa7284177a86d67ad88eab19452d549a. Actor509172 ArmyRoomSet07,
material-5 FloorGlowLines_Orange:1368vertices, два конечных разных UVsets по1368pairs. Alpha1
uvSource1 использует UV1; native enum1 соответствует второму набору. ПотеряUV1 не подтверждена.
Оба CMS alphaFactor1, unshadedtrue; emission multiplier3/1 и authored orange DDS. CLight не обязан
затемнять этот материал; нельзя менять текстуру/числа по PNG. Single-layer selected sequence/clock
потеря подтверждена и исправлена в PRIVATE clock profile выше; native GLstand concurrent overlay,
visibility/variant geometry ещё не квалифицированы. Для обычного floor lit materials и glow
нужен pixel→primitive trace до заявления общей причины. Native Light omitted defaults UNKNOWN:
registrar1.0/3.14/.001 — metadata, не ctor stores. Последняя передача Core exact6carrier proposal
отказана Cannot steer without active turn id; Core ACK propagation не получен. Private V3 exact2
независимо проверен; live не подключён.

Native camera: Models corrected FOV receipt ffe97012c40176b7844d80cabbab2f470433562bd177d81eae6a59ab95e2fa0c
в C:/MKTEMP/raynor-whiteout-ref-20261015/optical-native/fov-runtime-evidence-20261015.json.
World уже восстанавливает horizontal FOV Communicator; ±90 и numeric FOV patch не обоснованы.
Bounded direct-camera caller trace (rtt-camera-direct-evidence-20261015.json) не нашёл qualified native
RTT destination/subrect/mode; concrete bind anchor отсутствует. Generic RTT request не доказывает
native target dimensions. Editor закрыт; новых значений Rotation от пользователя нет.

Native Light bridge evidence C:/MKTEMP/cutscene-fidelity-20261014/editor-native-project/
cutscene-light-bridge-evidence-v2.json SHA c363426d29c29cca3013b8660440d5b96bea43d702444b11ba5403fb008ef8a4:
V4 raw30d97e0→RET30d9e79, V5 raw string-view descriptors подтверждают node.type==2 → LightSpot,
иначе LightOmni. V3/V4 hotspot+224/falloff+228 идут неизменными в2999240/2999230; destination
lightState+88/+8c пока recovered evidence. V6 raw1da7190 и V7 constants квалифицировали cone math:
C=cos(falloff/2), H=min(hotspot,.95*falloff), затем cos(H/2); полные углы в радианах.
V7 SHAa16c2eea2b766e14a6a91d7cfa316303e0ff0e6c56bbab391f5e4e0f32c08022, тот же private project.
Ctor defaults, message receiving dispatch и actual factory vptr не доказаны. Tangent bounds только
recovered. V3 starts mid-body30d98d4; не объявлять его function entry. Это static
read-only imported Editor image2147a8…, не запуск установленного редактора и не production code.

Далее: Core weighted carrier ACK, Integrator CLight closure + consumer landing, native local-light
transport/defaults и RTT framing, новый clock-fixed PNG/полный animatedWebP после освобождения памяти.
Mission CLight ambient=0:
48 active native local lights нельзя заменить произвольным closest-N или повышением ambient.
Новая визуальная приёмка пока НЕ достигнута.

## Текущий исходный срез

В существующий codec добавлены ActorState/SC2Scene dialect, native evaluator/playback helper,
readonly scene-at/facial-at и common world source. Parser/encoder/language provider прежние;
вторых часов, рендера, XML parser или игровой VM нет. Native edits пока dependency-required:
проверка повторного открытия изменений в SC2 Editor отложена пользователем.

Pure frame вычисляет Actor/TargetCamera, evaluated property curves/points, active shot/light/RTT
requests, полный набор authoring nodes. Hidden/zero-opacity actors исключены из presentation,
но hidden camera carrier сохраняет позу с явной диагностикой. Применяется team RGB/tint0..1;
fractional opacity передаётся через presentationOpacity → primitive tint alpha. HDR tint ещё
требует общего контракта; authored values не clamp-аппроксимируются.

LookAt: native request теперь содержит enclosing actor, target GUID/offset, type/attachId/ignoreEyes,
active interval, evaluated target properties и состояния ambiguous/missing/inactive. Invisible guides
сохраняются как dependencies. World даёт look-at-pose-required, actor yaw не меняется.
Blizzard PDF p21/30 и официальный ArtTools Tutorial_LookAt подтверждают model/bone gaze;
InstantStanding не оправдывает поворот всего actor к цели.
В Arrival315000 у Kerrigan активны Eyes/Head/Standing target guides, у Raynor LookAt уже закончились.

## Владение и зависимости

Core: F1/44b1d440, F3 final3578c258 (не использовать cc5dadfb отдельно), F2bd134963 last-wins;
F4-A3ff33f0b, F4-B40365385, F4-Ca301a23b source landed. Compiled closure не следует из HEAD.
Общий dist/vendor/acceptance/VSIX — INTEGRATOR, эта сессия их не обновляла. Пользователь явно
разрешил отдельную диагностическую сборку и необходимые scene правки. Runtime расположен в
C:/MKTEMP/cutscene-fidelity-20261014/source/{core,blizzard}; Core baseline0e4a47a3, Blizzard58e87a71,
consumer overlays43c67f52 и enumerated owned changes с SHA receipts. Это не release snapshot.
Текущий INTEGRATOR NEW4 —01a13d6c-f18c-7dd1-a66a-7bef2302babd; переданы source commits,
отсутствие наших .acceptance/portable окон и запрет включать live dirty. Старые thread IDs ниже — история.
Прямые технические согласования с владельцами теперь разрешены пользователем; общие сборки — NEW4.

Mirror/twoSided fix committed Core bd79296fb7c9c681ddb796fd9b3e137e430449b7, exact2source+2tests.
Flat MODEL sign + explicitCCW disabled-cull/restore; baseline no-local102LSB/state-order reproduced.
37Node/strict0,5actualGPU normals exactCPU/GPU и11GPU sequence cases PASS/0errors/0leaks.
Mirror private root C:/MKTEMP/scene-mirror-facing-20261015 содержит independent gate и commit
receipts: ownclean/indexempty, foreignbefore/after unchanged. Shared dist не менялся.

Private B перебазирован на bd79296f: C:/MKTEMP/cutscene-standard-local-rebased-20261015/source.
Final B-source.patch/source-sha256.json:7production+4existingtests. Independent FINAL PASS:
39Node/strict0;6kernel+9TS unchanged earlier PASS,0skips.30actualGPU cases =29standard+
1PBR preservation control. Standard raw premultipliedRGB<=1LSB, alpha exact; straight bound
ceil(255/alpha), поэтому alpha128 даёт2LSB (также reproduced на legacy directional).
PBR46LSB CPU/GPU mismatch preexisting: committedbd792 CPUbefore=after иGPUbefore=after exact;
не заявлять новый PBR parity. Baseline5controls independently rebuilt;17x17 exactzero center verified.
Retained11GPU comparisons exact0: absent/present/absent, sameobject rig delete/restore,
light value mutation, mixed-sign instances, positive rotating skin tangent/signed/object через
existing sampler/deformed owner. Negative-deforming skin/native acceptance не квалифицированы.
Existing sweep evicts unused variants: toggle compile2→4, changing values remains4; нового cache нет.
POST нашёл sameobject removal bug (121LSB GPU), исправлен guard previous spatial frame и добавлен
registered regression; beforefailure сохранён. Independent gate и POST audit FINAL PASS.
Core actual11file review выявил новый P2: browser global auto sceneLighting меняет PBR/unshaded
при omitted/empty context. Старые30GPU controls проверяли explicit context и не закрывают этот bug.
24новых controls reproduced12failures:8LSB PBR/5unshaded, single/mixed/composite. B SOURCE GO нет.
Отдельный reviewable prototype C:/MKTEMP/cutscene-light-preparation-repair-20261015 сохраняет
старый frozen11 root без изменений.13SHA:8production+5existingtests; auto adoption решает
existing typed standard-program pass, через existing materials sampler; browser не force public
sceneLighting. Independent61Node/strict0/24protectedGPU beforeafter exact0; lit standard auto==
explicit true и differsfalse112. Existing main30/baseline5/retained11/kernel6/TS9 owner rerun PASS.
Finder: autoSceneLighting — добавление к ЭКСПОРТИРУЕМОМУ package API (MaterialFrameOptions и
SceneMaterialContext), хотя SDK/raw JSON schema не меняются. Core дал explicit API design ACK для autoSceneLighting в обоих exported package types;
PBR/unshaded P2 закрыт для reviewed repair scope. Независимый Core rerun:61Scene+6kernel PASS.
Этот integration HOLD впоследствии снят (Core ff96f6e2 выше): Core потребовал private integration с текущими RTT hunks в трёх файлах
standard-program.ts, headless.ts, render/materials.ts. Копия C:/MKTEMP/cutscene-B-live-integration-20261015
сохраняет все три dirty RTT delta; пересечение полей context разрешено сохранением обоих полей.
Это не live правка. Node61+kernel6+9TS PASS; port-strict0. Changed lines всех трёх foreign RTT delta сохранены
точно; final private receipt готов, Core exact-hunk review ещё требуется.
Final B-only patch/13SHA/preservation и Core exact-hunk GO выполнены; landing ff96f6e2.
Старый B root наc923 — только история.
После B landing — C world locals и native CLight adapter. Новых acceptance PNG/WebP пока нет.
ModelRender01a13b7e-8ba6-70e0-b5a5-9a6e1aeceff9 получил technical concurrency ACK ровно для
rotation selector instanceVertex/worldObjectTransform + separate testappend и SDK rotation field:
они не перекрывают tracked RTT/opacity/composite hunks. Wholefile overwrite/stage не разрешён;
Ранние restpose/independentclock test hunks могут принадлежать прошлым ходам этого чата (Maps
history); слово «foreign» относилось к текущему mirror/B slice, не было доказательством авторства.
Все ранние hunks сохранить. Source GO/landing rotation решает Core/Runtime.

Models-agent: отдельная задача01a13a6a-9ffb-7442-86bd-73fec7efeb3a.
M1a581ce8ea исправил attached translation/scale interpolation, docs68ac5cb3, source61PASS;
quaternion/STC/weighted mixing и fresh Host proof ещё открыты. Полный status у Models handoff.
Consumer slice43c67f52 закоммичен:7 listed paths плюс animation-projection.ts import repair
(authored consumer → compiled native tracks, согласно единственному native build profile).
Models strict noEmit PASS с fresh native declarations в isolated profile;12 focused tests PASS.
Чистые M1a evaluator/tracks не менялись. Native RTT builder теперь содержит parked addition
video_channel−1/0..6 и RTT-only layers;15 tests PASS, parser/writer/constant priority сохранены.
Этот новый RTT slice пока live, не включён в уже созданный isolated portable Models bundle.
Package.json vendor path, Mod/Data/Game dirty changes чужие: не включать в commit.

Maps подтвердил отсутствие shared/catalog-light.js, strict-TS projection, pending patch и commit.
Existing map resolver проецирует только static ambient/directional и tone mapping; native local
position/fade/cone API отсутствует. Extraction и новые local/clock semantics — разные owner slices.
Maps остаётся единственным владельцем helper; Core не дал local projection SOURCE GO.
B current4-light profile не квалифицирует48/53 authored: beyond-budget refusal, без closestN.
Models подтвердил: новых quaternion/STC/weighted-mix исправлений сверх581ce8ea нет; writer
f50d198b и PHSH6cabbffa — отдельные задачи, не animation parity. Передан readonly saved Raynor
bundle raynor-saved-host-input-summary.json в fidelity private root: input hashes, UVMsha,
3M3A bindings/revisions, Talk05 .812priority4 + Stand1.489priority3,270channels each. Public
ContentSources raw identity теперь выполнен: C:/MKTEMP/cutscene-raynor-native-inputs-20261015/
payload-identities.json,4payloads/hashes, failures0. Current revision API read не выдаёт — saved
binding revision отдельно, не объявлять fresh revision parity. Models сделал readonly single-clip
numeric probe и raw BONE defaults: все4node local defaults identity, default-loss не установлен.
Expected native sampled joints/STC weights пока отсутствуют. Новый m3-loader-anchor-evidence.json
в fidelity root: imported Editor SHA2147a8d5…, raw BONE1eab2b0/LAYR1eaba80 и tag-admitted callers
подтверждают zero-header→flag10/ffff load fixup.6inputhashes и raw-window hashes; Models независимо
сверил BONEv1/stride160/offsets. Это bounded STATIC loader proof, не quat/STC/installed build/native
joint execution; later attachment flag handling не доказан.
Models исправил исследовательское сопоставление: UVM nodes0/58/60/61 соответствуют raw BONE0/45/47/48
(pelvis/helmet/neck/head), а не raw0/58/60/61. V1 raw-bones/loader-scope receipts superseded;
использовать raynor-raw-bones-20261015-v2.json, raynor-loader-scope-20261015-v2.json и
raynor-single-clip-numeric-20261015-v2.json в fidelity root. Generic single-clip matrices не изменились.
raynor-quaternion-intervals-20261015.json:170intervals, negative dots0, min dot.9997015086;
все используют существующий near-parallel nlerp branch. На actual Stand1.489/Talk05.812 evaluator
и UVM отличаются максимум5.552e-17. Это internal consistency, не independent native oracle;
сильное искажение портрета этим не объяснено. В8tracks по одному STC/STS hit: выборка не проверяет
конфликт STC. Следующий readonly запрос Models — attachment/coverage и composed Talk05+Stand
через существующие owners, без нового sampler, сортировки или предположений о weighted mixing.
Результат composed audit: raynor-composed-layer-evidence-20261015.json, SHA d2059ce749e86ee3b19986ebacdbdabf579a2306126eaf0fcb99059ecd1fc254.
Оба clips270rawTRShits/fallback0; Talk05 выигрывает270/270, composed==single Talk по4node matrices
и всем10posed primitives. Это generic consistency, не native correctness.
ВАЖНО: после этого аудита Cutscenes нашёл authored transition schedule в уже public-read XML:
inputs/cutscene_missionepilogue01start.sc2cutscene SHA248e45794b6d08d479bf6c8e064ea66a720bdb0dd2fbe9f6502637088ab06094,
line113 Raynor Talk05 start677/duration1056/blendTime500/blendOutTime450. На1489 осталось244ms:
время внутри authored final450ms window. Public frame layer этих blend fields/weight не содержит.
Line89 Artanis Talk03 даёт explicit weight.5/blendTime1000. Поэтому «нет authored schedule»
неверно: нет ещё подтверждённой exact native blend curve. Новый receipt raynor-authored-blend-schedule-20261015.json;
Models переданы anchors для дополнения audit. Не назначать линейный/smoothstep вес по догадке.
Native supplement: editor-native-project/cutscene-anim-blend-evidence.json, raw V2/V3 windows
того же imported image. Registration связывает blendTime→object+f4, blendOutTime→object+f8.
Новый cutscene-anim-interval-bound-evidence.json квалифицирует vtable3af1c88 через ctor307ed40:
virtual+108→3068b50 читает+c8, virtual+118→3068b40 читает+cc, virtual+e8→306e0e0 false.
Registration3079730 связывает+c8 со start и+cc с duration. Поэтому30815c0 на этом static path
допускает [start,start+duration+blendOutTime), для Talk05 это[677,2183). Raw V6 window3081bd0:900 (SHA2e7a27a5…) квалифицирует командный release:
после elapsed>duration вес=max(0,1-(elapsed-duration)/blendOutTime)*authoredWeight, с native f32
округлениями; weight XML связан с object+11c. На1489 Talk05 commandWeight=1, не244/450.
Это static imported-image evidence, не installed execution и не окончательный вес костной позы.
Blend-in envelope, controller mixing и причина portrait crop остаются открыты.
В существующий evaluator добавлена derived sceneAt.animationLayers: active/release, authoredWeight,
commandWeight и authored blend timings. activeClips, timeline end/length и resource animationClips
сохранены. Без второго clock/parser/sampler. В V2 start/duration/end/blends и суммы ограничены
signed int32; дробные/overflow caller clocks сохраняют прежний state, но derived commands отказаны
с diagnostic. Нельзя молча floor-ить presentation time: quantization ещё требует owner решения.
V2 source2 SHA2496af98…/8ba7a970…, patch33b20524…; Formats actual technical ACK,35tests/0skips,
evaluator-closure types0 и independent differential10times PASS. Full SC2 project types остаются FAIL
на существующих foreign world/facial dependency diagnostics; полной clean-HEAD квалификации нет.
Public ContentSources→Host→scene-at PASS: public-host-receipt-v3.json в
C:/MKTEMP/cutscene-native-transition-20261015. Real Mission1489=1,1733release=1,1958=.5,2183absent;
Artanis17000=.5;1958.5 сохраняет время и diagnostic без derived commands. Это V2 исходник в
отдельном runtime-v3 (имя runtime не версия semantics). Frozen profile dependencies, один evaluator
пересобран, временный node_modules junction только внутри MKTEMP записан в receipt; shared dist нет.
World/SDK ещё не потребляют commands; final pose/native visual acceptance этим не закрыта.
Свежий public Host probe artanis-weight-public-host.mjs на17000 воспроизвёл независимый дефект:
scene-at содержит active Talk03 weight.5/priority5/elapsed615; world frame Master_Artanis даёт
только Standpriority3 и animation-weight-unsupported. Сохранены raw/frame/resources/log и receipt
artanis-weight-public-host-receipt.json SHA70ac76eebffacc91af05800b54419f853bc961f88c3f0af74d131b0009d371c9.
Это актуальный public acquisition на private frozen profile с compiled-owner SHA; не общий current
build, не native pose oracle. После Core API/source decision использовать этот17000 case вместе
с1489/2237 для регрессии weighted layers, random seek и transitions; не чинить только Raynor crop.
Finder подтвердил existing weighted owner: codec-kit createModelPoseBlendSampler →
SequencePoseSampler.sampleBlendedPose, scene poseSamples consumers уже есть. Нельзя писать второй
TRS/quaternion blend. Но один sampleweight.5 нормализуется до1; нужен residual lower/base, а sparse
missing channels в poseSamples заменяются rest, что может ослабить body при Eyes overlay.
World layers SDK пока explicitly full-weight, sampleModelAnimationLayers — sparse priority winner.
Core должен согласовать один sparse-weight seam и omitted-weight compatibility; metadata
blendInSeconds/blendOutSeconds уже существуют в model facet/UVM. Второй UV формат не нужен.
Independent Whiteout numeric comparison выполнен: original WhiteoutFlakes d2756ce… с
pinned WhiteoutLib f3e57087… собран в MKTEMP через Emscripten C++20 и запущен Node/WASM.
Оригинальные Load→AttachAnimationFile→Evaluate и SkinVertices, без порта алгоритмов. Receipt
C:/MKTEMP/raynor-whiteout-ref-20261015/whiteout-raynor-reference-execution-20261015.json
SHAfb5f87b9… supersedes feasibility blocker. Stand1489: max world matrix delta5.96054e-6,
skin5.85938e-6, posed coordinate1.04398e-4; Talk05 elapsed812:4.66110e-5/4.72534e-5/2.52572e-5.
Проверены4 name-mapped bones и10 unique posed regions. Это independent single-clip comparison,
не native game parity/weighted controller/camera/visual acceptance; значительный crop пока не объяснён.
NEW4 exact4 window выполнен: native projection80068da2. B/world/SDK и чужие WIP в native пакет не вошли.
Core owned live slices: opacity/fallback mask fade, additive CPU RGB fade, composite passthrough,
cached texture clone перед transferable reply; neutral WorldSceneFrame.renderTextures и CPU
offscreen pass reuse. GPU RTT offscreen/destination propagation пока отсутствуют.

## Проверки foundation

Независимый gate-check:61PASS,0skips,6files (codec19/evaluate17/world12/language9/facial3/legacy1).
visible="false" и decimal zero проверены; evaluator/world используют общий native flag parser.
Owner tier исключает cutscene-corpus.test.ts, поэтому это не повтор2233-file corpus qualification.
PRE/POST removal audit: parser/writer/language/exports/ops сохранены, LookAt не подменён actor rotation.
Source noEmit PASS с current Core source aliases, DOM/node, exactOptional true и совместимым Core profile;
MKTEMP config cutscene-goal-source-tsconfig.json. Это не published dependency/dist proof.
Исходная попытка typecheck по stage declarations показала stale exports, не code regression;
вторая широкая source config поправлена на rootDir workspace и Core compiler flags.
Последние логи: C:/MKTEMP/cutscene-render/cutscene-foundation-flags-final-{gate,types}.log.

## Реальные ресурсы и предыдущий диагностический кадр

Native source: Campaigns/voidstory.sc2campaign/base.sc2data/cutscenes/
cutscene_epilogue01arrival.sc2cutscene. BaseMods Campaigns/VoidStory.SC2Campaign;
установка F:/GAMES/Blizzard/StarCraft II, cascOnline:false, public ContentSources/Host.
Time315000 nativeMs, MasterC, Artanis018+1046ms. Bookmark313954; raw timeline не videoelapsed.
16 selected objects converted после selective retries. Pose clips Artanis642/417, Kerrigan603,
Raynor285, eye overlays присутствуют; прежние Step channels нуждаются в новом M1a product proof.

PNG C:/MKTEMP/cutscene-render/arrival-315000-fullhd.png,1920x1080,3441643bytes,
SHA256242dac952bbc7210811be3bffb4a477dd0fa43bb376be82d8c371a8279ff706b.
Это mixed-stage snapshot ДО нового tint/gaze/M1a, не fresh MCP/native parity:
floor/hologram пересвечены, facing/LookAt/FaceFX не совпадают,8 unsupported material features,
1 missing DDS SM_RaynorGun_Diff.dds без подобранной замены. Arrival0RTT;
RTT acceptance MissionEpilogue01Start Raynor screen около2237nativeMs.

arrival-native-315000.json устарел: Kerrigan visible0 было до persistentpointfix238928→1.
Актуальный frame JSON содержит Kerrigan. Не принимать старый JSON за текущий evaluator.
Profile/models/ARRIVAL_ISOLATED_HOST_PROFILE_2026-10-14.md разделяет fresh Host acquisition,
selective retries, cached PNG и настоящие MCP calls; они не взаимозаменяемое доказательство.

## Следующие действия

1. Улучшить полноту/частоту WebP:2frames320x180 public export готов,15/16models.6frames640x360
   превысили encoder180s. Real decode Pillow подтвердил2frames×1000ms,55558changedpixels/57600.
2. Prepared-program reuse fix перенесён в isolated renderer. Fresh public PNG process
   arrival-png-clock-public-mcp.mjs завершился client REQUEST_TIMEOUT900000ms без нового PNG.
   Cached material-clock QA1280x720 получен: изменил glare, но orange floor остаётся; sample
   этой QA старый, без нового presentationOpacity, поэтому не использовать вместо fresh MCP.
   CPU раньше заново sample material в t=0, теперь принимает worldWebGlScenePrograms текущего
   plan.13 direct scene checks PASS, включая два экземпляра с clocks0.25/0.75 и texture identity;
   ещё13 shared material regression checks PASS. Strict Scene source noEmit и Cutscene noEmit PASS.
3. Завершить source typecheck/native RTT product proof, coherence commit и POST audit. Live
   headless.ts содержит также чужие terrain/water изменения: stage только собственные hunks.
4. Реализовать GPU RTT destination/shadow/tone-map lifecycle через существующий world pass;
   квалифицировать native RTT visibility/object scope и target size в MissionEpilogue01Start.
5. Применить model gaze через neutral pose owner; подключить готовый CLight helper от Maps;
   сопоставить placement/root/camera и quaternion policy с WhiteoutFlakes/native evidence.

## Новые реальные артефакты и проверки

arrival-315000-public-mcp.png в C:/MKTEMP/cutscene-fidelity-20261014:1920x1080,3103688bytes,
MCP models16/16converted. Source camera/poses/M1a/composite/opacity/texture-transfer присутствуют.
Это настоящий public modkit.world_scene render, не cached prepared-bin render. Пол ещё orange,
Raynor facing/Artanis overlap неверны; материал-clock fix в этом PNG ещё не применён.
World source snapshotId синхронным полем отсутствует в capability wire: MCP сверяет frame с
source.info().snapshotId, а не убирает snapshot validation.
MCP animation pre-samples union всех кадров, retains carriers, loads sequentially; encoder180s
начинается после bounded Host acquisition.31 independent consumer checks PASS (6Core/13Scene/
12Cutscene), затем28 native RTT/world checks PASS и отдельный pipe-buffer regression PASS.
Прототип CPU RTT (bounded8views/4Mtargetpixels, common default512) проверен colored secondary
view → RTT-only material.7native channels остаются в adapter, neutral target IDs arbitrary.
Native scope/background/size не квалифицированы, hidden carrier сохраняется с opacity0.
WebP arrival-artanis018-public-mcp.webp:27426bytes,320x180,2frames,1fps,2s,
SHA075b401b89b1199b4793a1d0edef16ab2967be30cc2e646b6377dd0551bfdd13.
MCP report явно partial/capped:15/16, companion30s deadline, native partial diagnostics.
Реальный Mission RTT PNG теперь получен (см. ниже); принятого по fidelity WebP ещё нет.
Не считать цель завершённой.
INTEGRATOR Core Git cutover завершён: canonical8c3508b5 (исторические hashes в receipt не currentmain).
Для coherent consumer commit запрошен serialized/isolated index window; Core scope review
ещё не разрешён, поэтому только private/read-only. Новый ModelRender владелец уведомлён об owned
dirty hunks. Новый frozen candidate Coree4fb5a6f/Blizzard3b746e59/Runtimeac66490c;
наши RTT/media изменения туда не входят.
Shared dist rollout ведёт INTEGRATOR; live dist не пересобирать и не использовать для этих QA.

Public Host camera samples: до317000 MasterC eye[-.734955,.482651,-1.361633]; с318000 close
eye[-.686844,.718365,-3.552227], FOV0.134817. camera QA318000 показывает close Artanis,
перекрытый Selendis: поздняя камера не объясняет широкое reference отличие. JSON fullframes
сохранён в arrival-artanis018-full-frames.json. Eye overlays всех3heroes не содержат Root/Pelvis;
гипотеза, что eye layer сбрасывает body root, не подтверждена. Не вводить guessed actor rotation.
Finder: existing aimRotation в scene/model/billboards.ts и post-pose stage sampler; UVM billboard
контракт только view/eye, actor-target Standing/Head/Eyes не определены. PATU metadata теряет
axis/limit/weight поля, но связь с cinematic gaze ещё не доказана: сначала actual rig evidence.

Основной implementation reference WhiteoutFlakes d2756ce; SC2 final validation.
FIDELITY_PLAN_2026-10-14.md commit75695108 детализирует U1/U2/U8, не второй общий roadmap.
RE optional: local sc2-ida setup не содержит exe/idb/i64, callable IDA tools отсутствуют;
anchors требуют build/hash/RVA/assembly qualification. RE запусков не было.

Исторический RTT patch/test сохранены C:/MODDING/parked/blizzard-formats/rtt-material;
patch теперь применён в live builder и test; compiled native/runtime product proof ещё впереди.
Read-only worktree C:/MKTEMP/catalog-model-head-dfa6c896 имеет node_modules junctions;
при очистке удалять сами junction entries до worktree, не рекурсивно их targets.

## Текущий RTT и выбор M3A для кадров

Public Host inspection MissionEpilogue01Start2237 native ms завершён:
16objects, render-texture:0 → modelCamera objectId130493/cameraIndex0,
nativeGUID9976244838863134203/modelLink SMX2_Bridge_Communicator.
Carrier visible (presentationOpacity absent), identity transform; не применять hidden0 heuristic.
Master_Raynor расположен UVWy=-29.483492, RAYNOR_SET=-30.090446: отдельный offscreen set
подтверждён native positions; направление actual M3 camera ещё требует проверки.
mission-native-2237.json/frame/resources и Host log находятся в fidelity temp root.
Real public MCP RTT PNG640x360 получен: mission-2237-rtt-public-mcp.png,400284bytes,
SHA1b4f8f47a6ef039ca0a52a8c73fcd21fd0f2dc46a5fb8a03b1ad6295b029032d.
Visual QA: RTT image visible на communicator, портрет incorrectly cropped; lighting/materials
сильно отличаются,13/16models converted.3 companion-budget-exceeded(30000ms),2animation-unavailable;
report output-capped, поэтому не считать diagnostics полными. qualification JSON сохранён.
Это Host/MCP-verified first actual RTT path; scope/lens/pose/native rendering parity не приняты.

Cutscene source.model теперь использует существующий request.animationNames при explicit M3A,
без selector оставляет authored union. Explicit [] передаётся Host admission, не означает full.
Independent13world tests PASS/skip0; strict source noEmit PASS.
Core consumer subset bridge только private: optional per-resource map → normalized cache key →
source.model; MCP unions primary/layer names всех requested sampled frames, включая late actors.
Private collector cache1PASS + actual public MCP tests3PASS (PNG, subset, two-frame WebP).
Patch/receipt: parked/blizzard-formats/frame-animation-subsets/core-consumer.patch (3Corepaths).
До Core scope review не применять: liveCore/index/dist не изменялись этим bridge.
Node closure check подтверждает ui/scene/host/sdk внутри frozen source/core, не live dist.

Lighting finder: catalog-light.js объявлен AGENTS, но live отсутствует. CLight helper ждём Maps;
native Cutscene Light — отдельные nodes, helper не заменяет их. World lighting/frame сейчас только
directional; renderer SceneRendererLight и preview-lighting уже умеют point/spot (≤4).
Нужен маленький Core bridge, не новый light algorithm. Native type2 назван Spot в real fixture;
единицы hotspot/falloff и rotation→ray не доказаны. M3 light enum другая — не переносить.
GPU RTT finder: existing drawWithResources получает internal destination/frame dimensions;
shadow reset и toneMapper.finish должны возвращаться к destination, finally восстанавливает
previous framebuffer/viewport. Native handles принадлежат renderer, без fake RGBA/readback.
Stable bounded target pool, sequential secondary/main passes, exclude active feedback channel;
cached material lease должен учитывать target handle. Реализация GPU отсутствует.

## Companion deadline: private Core prototype

3 Mission failures происходят ДО model conversion: optional DDS lookup exceeds30000ms,
затем pin-unsatisfied/model-resource-unavailable. Deadline policy не менять вслепую.
Finder: existing content-source-companion.list повторяет directory listing для каждого prefix;
input-resolution enumeration memo использует scope/prefix/namePrefix, а не общий folder.
Private existing-origin patch:16FIFO folder promises/casefold normalized key, first actual path;
failure cleanup проверяет promise identity, не держит thrown absence, successful[] snapshot retained.
Post-list abort check сохраняет отмену и для empty results; matching/order/reads/exports прежние.
PRE/POST audits PASS; Node5 + existing/new Vitest8 PASS. Patch applies cleanly to live (check only).
parked/blizzard-formats/companion-directory-memo/core-owner.patch:source+typed regression test.
Direct private noEmit blocked by frozen SDK/VFS declaration exports and unrelated Host types;
не объявлять его typecheck зелёным. До coherent Core source/decl closure owner review необходим.
Live Core source/index/dist не менялись. Cache bounded by16folders, не общей суммой entries;
listing snapshot lifetime/freshness/retention должен оценить Core перед посадкой.
Повторный actual MCP PNG с memo завершён exit1: public generic x3.mcp/host-operation-failed;
внутренняя причина ещё не установлена. session1751 закрыта. Новый PNG не получен.
mission-memo-listing-stats.json: Liberty.SC2Mod/Assets/Textures152calls/44.44s,
Void.SC2Campaign/Assets/Textures208calls/2.51s, VoidStoryAssets/Textures208 failures.
Directory listings всё ещё повторяются в этом route; patched origin не покрывает весь layered path.
Нельзя заявлять runtime speedup/16of16 или causal regression от memo по genericerror.
Первичный PNG13/16 остаётся validdiagnostic. Нужно capture model outcome IDs/internal error.

PDF снова извлечён (pypdf установлен только fidelity/python-libs):Blizzard p21–22/p30 требует
StoryMode LookAt rig, stylesblend speed/strength, separate eye/head targets; не guessed actor yaw.
p24 подтверждает RTTcamera→7channels/CampaignMode. p16–17/p34 описывает hotspot radius/falloff/
range distance source→target, но numeric conversion/rotation ray явно не задаёт.

## Native reference получен от пользователя

SC2 Editor screenshot Cutscene_MissionEpilogue01Start на00:00:1.489,
context title campaign/void/paiur04.sc2map. Сохранён fidelity/mission-1489-editor-reference.png,
SHA93770fac1cc81d6986e57f576089812972079992a0da7b87e88377528d621e47.
Это native Editor visual oracle; screenshot не доказывает build/hash/XML/game executable.
Metadata/comparison JSON рядом. Исходный attachment из TEMP не редактирован.
Reference: Raynorface+helmet в RTT, purple nebula background, pink/violet reflective materials;
наш2237PNG: incorrectbody/armor crop, отсутствующая nebula, flat bronze/gray response.
Public Host sampled1489: mainVFOV0.5571124657, unchanged vs2237; cameraeye displacement0.0508964,
target displacement0.0354166; actor object transforms identical, RTTCommu130493 camera0 same.
Bone pose/texture/camera animation остаются time dependent — pairedPNG делать1489, не2237.
PAiur04 effective catalog/dependency context ещё не сопоставлен с VoidStory baseMods.

Finder structural bug: worldModelAnimation builds composed rest-pose clip using layer.timeSeconds,
без sequenceIndex; model camera node pose sampled correctly, но resolveUvmCamera gets worldtime0
(frame.animationTimes) and missingsequence => scalar lens default/not layer clock.
Нужен one-model Host Commu UVM camera/UV_game scalartrack inspection: доказывать animated lens
прежде связывать этот дефект с crop. Не поправлять FOV/yaw вручную под screenshot.
Core regression scope: world-camera-perspective composed layer1.489, worldclock0, animatedbone+lens.

Single-Commu Host probe завершён failure: companion-budget-exceeded/model-resource-unavailable,
communicator-camera-model-result.bin содержит unresolved outcome, не UVM; CAM scalar tracks ещё
не проверены на этой actual модели. Структурный clock defect не считать установленной причиной crop.

## SC2Editor-MCP-Codex: read-only review

Reference HEAD fc0b9a641ecc3c62ddc365f943653207b196d268, package1.1.0-alpha.20;
source и targeted tests прочитаны, проект не собирался/не запускался/не изменялся.
Подробности и owner mapping внесены в FIDELITY_PLAN_2026-10-14.md §6, без нового roadmap.
Полезные evidence: per-property STC/STS/layer sampling общий для bone/CAM/MAT/LITE;
PATU forward/limits/weights и GameUIData LookAt; animated UV/composite pass alpha;
optional texture failure сохраняет geometry; reusable GPU RTT FBO/per-sampler state.
Existing buildTurrets уже даёт группы/кости, его projection теряет перечисленные PATU поля —
проверить полный UVM metadata path прежде расширения, не новый M3 parser.
Ограничения: engineValidated/materialParity/nativeBlendEquationsValidated false;
synthetic camera/constraint fixtures, GLSL string RTT tests и mock sampler test не native proof.
Software PNG route отличается от WebGL2; предыдущий RTT frame feedback history dependent;
camera first-entry fallback; LookAt Rate parsed, но в applyConstraints не применён;
shader patching strings и упрощённый catalog/CASC lookup не переносить.
Original Attribution License, vendor/blizzard-models GPL-2.0; code не копировался.
Пользовательский screenshot preview2237 имеет nebula/декорации, но portrait RTT также отсутствует;
широкий aspect~3.28 отличается от нашего16:9 и native Editor viewport. Это дополнительный пример,
не замена native Editor1489. WhiteoutFlakes остаётся primary, цель PNG/WebP не завершена.

## Camera layer clock fix (15.10, private Core)

Исправлен source/core scene/src/{world/webgl.ts,uvm/cameras.ts,uvm/scene-properties.ts}:
shared selectedWorldModelAnimationLayers сохраняет sequenceIndex/time/duration/loop/priority;
optional property layers передаются lens sampler, используют существующую interpolation;
sparse missing/empty channel abstains, highestpriority/laterauthored ties как текущий TRS owner.
Concurrent wrapSeconds остаётся в existing effect sampler, explicit duration0 не заменяется fallback.
Bounds32/key/width/cancellation и full final lens validation сохраняются; single-sequence route прежний.
Это existing full-weight override, не доказанные native weighted blends.
Direct Node16PASS/skip0 (7new+9existing), independent gate-check подтвердил source→compiled hashes
и private aliases. Fixture проверяет camera node pose/lens, не skinning palette/native Commu parity.
Scoped noEmit exit1:400 diagnostics из отсутствующих frozen declarations (SDK maps и другие),
type proof не зелёный; нужна coherent private declaration closure перед landing.
POST optional track.keys guard исправлен; parser продолжает валидировать наличие keys.

Owner review patch: parked/blizzard-formats/camera-layer-clocks/core-owner.patch,4paths,
git apply --check PASS (не applied). world patch содержит ТОЛЬКО4camera-clock hunks;
отличия frozen privateworld от newer live RTT/opacity/composite slices исключены из patch.
Live Core source/index/dist не изменены. Общие cinematic paths остаются на scope-review hold.

Два дополнительных single-Commu Host probes с harness-only public-list memo завершены
companion-budget-exceeded30s; CAM UVM не получен, старыйPNG остаётся diagnostic13/16.
Последний communicator-listing-probe-stats.json:258observed list calls/0reused/~36.5ms,
в основном отсутствующие fallback Assets/Textures без base.sc2assets. Эти наблюдения НЕ покрывают
все внутренние mod-context namespace listings и не устанавливают причину всего deadline.
Не увеличивать deadline/не объявлять memo speedup; нужен trace existing primary companion route.
Оба process handles terminal(exit1); probes не повторять без новой инструментальной гипотезы.

## Companion admission: actual trace and private resolution lease (15.10)

Previous goal turn — progress: camera clock owner slice implemented/tested; this turn actual
Host tracing changed the next action. No deadline increase. All transient traces live in C:/MKTEMP.
communicator-per-path-locate-trace.json: optional textures requirement,64prefix/scope enumerations,
32exact locate contexts; context.locate≈50.93s, open≈3.98s, read≈0.55s, dispose≈1.33ms.
Checkpoint validate:textures hit≈55.736s. Fast fallback directory calls did not explain the delay.
Neither composite nor single namespace page callbacks were on this route. Existing owner is
content-dependency-operations.createContentAssetOrigin: per-path openModContext→locate→read→dispose.
SC2 ModContext.locate calls resolved.files for every layer; manager layerFiles cache has16MiB
accounted metadata budget. Cache churn/oversized entries are now a hypothesis, not measured proof.

Private Host functional prototype: source/core/packages/host/src/{input-resolution.ts,
content-dependency-operations.ts}. Optional Host-private acquireResolution lease; layered children
retain precedence/case, forResource rebases both plain and acquired origin. Resolver deadline starts
before acquisition and release runs after buildAssetInput/failure. Content origin borrows one lazy
context per resolution; standalone per-path behavior unchanged. bytes.slice owns deferred data;
artifactByteSourceFromBytes snapshots containerContext and pins it into source revision.
Located assets now retain that ArtifactByteSource BEFORE contextdispose, not raw mutable metadata.
Lateopen returns the same pinned source; strengthened fixture mutates provider metadata ondispose
and the two deferredbindings retain original metadata/bytes. Current10Node tests PASS.
Independent repeat confirmed current source→JS byte equivalence and strengthened metadata fixture.
After this safeguard change, existing content-dependency-operations owner suite8PASS/skip0.
10direct Node tests PASS/no skips, independently repeated: two deferredbindings after provider byte
mutation and contextdispose, concurrent isolation, lazyzero-open, deadline/abort, missing/failedopen,
partial acquisition cleanup preserving error, precedence/releases, forResource and no-requirements.
PRE/POST audit passed. Scope type proof remains incomplete with stale private declaration closure.
Original frozen owner suites:63assertions, default5s harness had62PASS/1inventory-signature timeout;
same63assertions pass withtestTimeout15s. Host30s deadline unchanged. Not a full green Core gate.

Earlier lease-only probe confirms resolver acquires=true,1borrowed context,8locate calls;
they consumed≈32.98s and source.model remained companion-budget-exceeded. This preceded the
measured ModData lookup fix below; it is not the latest result.
Different machine load between probes; do not claim measured speedup or corrected camera.
communicator-primary-companion-trace.json currently contains scoped-lease diagnostics;
communicator-scoped-lease-trace-host.log session58548 terminalexit1. Earlier scoped aliases session86944
also terminalexit1. All active probes/tests are finished; no process wait remains.

parked/blizzard-formats/resolution-context-lease/core-owner.patch:2Hostsources+focused Vitest proposal;
git apply --check PASS, not applied. Proposal fixture typing still needs strict owner check.
Global TEMP trace hooks not included. Live Core/Blizzard Mod sources/index/dist unchanged.
Integrator received diagnosis and request for Mod&Data owner to inspect actual index rebuild/churn.
LoaderMetadataCache outcomes are now measured and the private ModData prototype is tested below.
Native PNG/WebP acceptance and the full goal remain incomplete.
Additional parked-patch review notifications were NOT delivered: app returned Cannot steer
Integrator01a13b12-9a52-70b3-bea0-ab92487d126d without an active turn id. Earlier actual diagnosis
message was delivered. Do not infer owner approval from this failure; private patches remain onhold.

## ModData point-metadata lookup (15.10, private owner slice)

Actual scalar trace captured0dropped events: Liberty56,113,918accounted bytes/179619paths,
Void50,847,032/164538, VoidStory22,191,322/68193 and LibertyCampaign20,125,662/56471 exceed
layerFiles16MiB and are immediately forgotten. A single Commu admission rebuilt111tables,
106oversized;32locates≈23.978s. Files/bytes/order/budgets were unchanged during tracing.
communicator-loader-cache-summary.json is the measured baseline, not a cache-size hypothesis.

Private existing owner slice: modules/mod/shared/workspace/{vfs,content-source-provider,
mod-context,mod-contexts}.ts. BaseReader optional pointFiles capability returns metadata-only
locate/directory names; ContentSourceReader extracts the existing readListed membership path.
Ambiguous directory case uses existing full-list winner. VFS callbacks check realm open;
prefixed forwards; loose/unsupported readers keep original full-table path. ResolvedMod guards
chain membership. ModContext reverse-layer/per-spelling precedence and locale order unchanged.
Any active text overlay disables point lookup, preserving virtual/empty locale components exactly.
One existing directory-retention implementation; no new cache/parser/SDK contract/deadline policy.

9Node equivalence tests compare with actual prior full-table source; independent PASS/no skips.
Typed proposal extends registered loader-metadata-cache.test.ts (quick/owner): oversized locate
does not relist Directory399, plus case/layer/locale/overlay metadata regressions.14Vitest assertions
PASS/no skips independently; detached body/compiled source correspondences checked. Source noEmit
is NOT green: frozen SDK declaration exports absent after resolving @types/node explicitly.
PRE/POST audits complete; VFS checks before async callback, not strict mid-await revocation.

Fresh Host after point fix:9table loads/4oversized(initial Data work),32locates≈308ms,1context.
UVM byte-identical to baseline SHA256b6ea42b5725edbc625ef9536463abf8194da9e2ca247d5c4e183c13a7c370864.
Timing observational with variable machine load; structural rebuild reduction established.
Receipt fidelity/mod-metadata-point-host-receipt.json. Temporary scalar hooks restored out of
LoaderMetadataCache and lease-owned Host JS after terminal probe61519. No live ModData/Core/dist edits.

Parked patch: parked/blizzard-formats/mod-metadata-point/mod-owner.patch,4sources+existingtest.
git apply--check PASS in live Blizzard, NOT applied. Integrator notification failed again with
Cannot steer without active turn id; no approval inferred. Required review/landing by Mod & Data.

Actual Commu model obtained through Host; camera0 Stand Work has unchanged frame/lens at0,
1489 and2237. HFOV≈0.7610128, near≈0.01, far≈10, eye≈[0,-28.731188,1.952078]. No animated scalar
CAM channel in projected document for this clip. Thus camera-clock bug not proven cause of RTTcrop.
communicator-camera-model-result.bin/.uvm/document/summary and actual-camera-times.json retained.

Fresh public MCP Mission1489:16/16models, no companion-budget failures; PNG
mission-1489-point-public-mcp.png640x360/155526bytes,
SHA2563c306ddd4f335eb6ca0451c3ab5f6cfa1a432cdc2a4b5828f55e0fb8ab322c33.
Image is WRONG: close surface/floor hides cast and communicator. Earlier camera-clock-only PNG
1489 had14/16 (two deadline failures), proving full admission exposes another geometric/render issue.
Do not accept16/16 as fidelity; Arrival reference PNG/WebP and correct Raynor RTT still outstanding.
Host pose/pick probe21747 terminalexit0: mission-1489-model-results.bin56,431,406bytes,16converted.
Existing pickWorldWebGl gives expected Bridge/Communicator intersections (no foreground wall).
Per-object CPU raster identifies Bridge00 as the full-screen occluder. Main-only render already
wrong and main/RTT/main identical before rebasing: the observed occlusion did not require RTT.

Two PRIVATE integration gaps corrected by reusing existing Core source, no new renderer:
- compile-owned-scene had omitted render/headless.ts. Frozen base/PBR route accepted negative W;
  existing live Core clipTriangle/ClipVertex implementation integrated into private CPU module.
  Source is a read-only MIXED owner snapshot, SHA in existing-cpu-clipping-integration.json;
  no live edits/landing. Independent original Node headless tests7PASS/skip0, exact source→JS check.
- compile-camera-layer-clocks had rebuilt frozen world source without RTT fields, stripping prior
  context/target-texture forwarding from compiled world. rebase-private-world-clock.mjs snapshots
  current existing world source and applies ONLYfour pending camera-clock hunks in private root.
  Existing RTT/opacity/composite retained; independent16camera tests PASS and source/JS/diff verified.
  world-clock-coherent-rebase.json is current world source receipt, not the old frozen receipt.
  Do not rerun park-camera-layer-clocks.mjs against rebased source without reviewing hunk counts;
  existing parked patch is already valid. Broad owned-scene compile would overwrite the clock fix.

Offline diagnostic over actual Host models128x72/RTT64: ordinary view no longer occluded,
RTTchangesRGBA and before/after main views equal. native body/armor crop remains. Low texture
budgets/cached model bundle make this a diagnostic, not public MCP/native acceptance.

Fresh coherent public MCP session94267 terminalexit0:
mission-1489-coherent-public-mcp.png640x360/445291bytes,
SHA256e0a5ca86f375ab8fdcd1f52d5f0e863217a48f859ff9d12b388e580c2f56994d.
Nebula/decorations/RTT now visible, but15/16: model9778 Master_Artanis failed operation cancelled
(worker late reply665), no new companion-budget failure. Floor orange/lighting wrong and RTTshows
body rather thanface.16model admission proved in previous runs, this cold acquisition notcomplete.

Finder: shared/catalog-model.js projects asset/variation only, NOT CModel ScaleMin/ScaleMax.
Cutscene actors use authored p.scale only; missing intrinsic scale is a testable crop hypothesis,
not a reason to guess .5. CModel fields are C3Vector. Same public catalog route uses
ModContext.query({kind:'data.entities',refs:[{namespace:'Model',entityId}]}).
Public model-scale context probe83853 terminalexit0. model-scale-public-context.json contains
layers/raw entities/fieldSources/sources/fieldLexemes. Effective ScaleMin=ScaleMax="1.000000,1.000000,
1.000000" for Raynor, Commu, Artanis and RaynorSet in VoidStory closure. This REFUTES a missing .5
multiplier as crop explanation in this closure; do not implement that guess. Paiur04 map-specific
context still not compared with native reference, so do not extrapolate to its overrides.
Numerical Raynor head/helmet check complete via existing worldModelAnimation/createModelSceneSampler
over saved actual Host results. Composed head square RTT NDC[-0.613,-0.191], depth0.4365; helmet
also inside. Raynor-only256x256 existing headless route still shows side armor. This narrows the
question to orientation/pose/skin/coverage, NOT a proven cause. Diagnostic texture budgets unchanged;
mission-head-camera-diagnostic.json and communicator-raynor/all-diagnostic PNGs are not acceptance.
Commu native camera bone6 maps projected parent node-6, child node-8 identity; Stand Work has
only7visibility channels/no camera TRS. Reference pure actor Z270 sign matches native→UVW mapping;
no added twist or scale justified. Native FOV axis differs from Models pinned vertical preview
policy, but square RTT is identical for either axis. Reference screenshot2237 has no Raynor face,
therefore is useful behavior evidence and not native fidelity proof (reference HEAD unchanged).
Bounded root/camera matrices equal Three composition of admitted node/TRS data (maxdiff<2.6e-8);
receipt mission-source-frame-diagnostic.json, no native-semantics claim. Identity Raynor rotation
counterfactual shows actual face/helmet, not a product correction or acceptance PNG.
Public ContentSources roots/list/files checked offline: no native Paiur04 in Void SC2Map search,
installation Maps or Maps cache; custom cached Zerg Epilogue map is not native reference.

User asks about decompiled game/editor: available readonly references SC2Editor1 recovered_cpp
and SC2Editor2 SQLite schema48. Metadata describes Editor5.0.16.97563, EXE hash9CAB25DB... and
specific recovered/runtime/static address domains. Graph get_architecture timedout120s again;
readonly node:sqlite and bounded existing CSV/jobs manifest lookup used, no reference mutations.
FOUND native bearing evidence: SC2Editor1 decompiled_full_v2/part_174178/batch_174178_231904.c
rotation setter436929 and axis setters call helper FUN_7ff7441e5d00:433166. At433214 it passes
xRad,yRad,(z+90)Rad to matrix builder, then matrix→quat and instance application433237. Corpus
SHA CD12A2A500524D65F60E7960563C3FD63E3D8C60E54A391AA885BE0D745511EF matches SHA256SUMS.
Readonly private Ghidra copy editor-native-project/SC2Edit uses imagebase140000000 and codeRVA0;
F00000 runtime bias from SC2Editor2 does not apply (lands in .rdata). No analysis/Program writes.
Raw registrar3086d80 confirms actual rotation/XYZ strings, setters and offsets1a0/1a4/1a8.
Descriptor306f8d0 names CCutsceneNodeActor, parent30702e0 CCutsceneNodeObject. Sibling camera/light
branches do not establish global object policy. Factory3067b50→constructor30917c0→base3084dd0
proves defaultXYZ0 and flag1dc=1; property string3af2cc0 proves useSceneRotation. Actor constructor
does not overwrite those fields. No guessed default=-90. Native +90 remains deferred until
camera/resource basis and scene rotation composition are qualified. Editor was closed by user.
Math3ed3a0/3ecc90/39dae0 confirms active Rx·Ry·Rz. Existing Cutscene world rotation corrected only
for SC2Cutscene mixed axes; ActorState matrix unchanged. Original registered world.test directly:
14PASS/0skips on full current source, no native fidelity claim; log rotation-gate-independent.log.
Narrow HEAD-based candidate additionally3selectedPASS/10excluded by filter, hidden carrier checks
existing diagnostic without dirty opacity; log rotation-candidate-independent.log.
rotation-clean-candidate/rotation-only.patch keeps prior dirty RTT/opacity/selectors outside commit.
Rotation source/tests/docs committed981cd3c1. Private compile narrowed to one Cutscene world.js,
receipt rotation-only-compile-receipt.json; existing scene/Host/UV overlays preserved.
Fresh Host frame mission-rotation-frame-1489.json has16objects and unchanged RTT carrier identity.
Diagnostic PNG mission-1489-rotation-order-diagnostic.png640x360 reuses saved16-model bundle/limited
textures, not fresh MCP acquisition or acceptance. Only admitted mixedXYZ Void Skybox rotation
changed; Raynor portrait and orange material/light discrepancy remain. All probe/render sessions
terminal. No fulltypecheck/release snapshot claim.
Installed Editor equivalence and SC2Editor1/2 binary identity remain unqualified.
Receipt editor-rotation-evidence.json. No proprietary body copied into production.
Finder/PRE audit complete: only Cutscene world rotation adapter owns facing correction; legacy
ActorState shares it and must retain existing behavior until separately proved. Camera carrier
uses same instance, so blanket+90 rotates eye/forward too. Do not use guessed default to hide that.
Native camera trace уточнён (15.10): actor+0x230/309c160 возвращает NAME камеры, не frame.
3093020→1d5a630 привязывает model/index к view, но не вычисляет камеру. Actual frame1d5cb50
вызывает bone update1d456e0/owner dispatch1d4e5e0 и получает animated CAM lens из model+0x3b8.
Root BONE parentIndex=ffff получает parent=model owner, не null; все bone получают owner через
1d44b10. Поэтому camera matrix включает instance root TRS, model-space exception не обоснован.
Sources: retry_076000/batch_076000_116452.c:1385365,1385388–94,1394854–1394992.
Callers1dfaf1c/2816f78 оказались bone constraint/attachment setup; identity reset не heading rule.
Следующая точная цепочка Actor quaternion application:44c220→44c020→285c4e0→285c430.
Raw44c220 positive branch вызывает unit+0x300 перед wrapper;285c430 использует +0x308/+0x310
и передаёт payload в +0x2f8. Actual CActorModel targets теперь установлены (см. ниже), но полный
native frame ещё не квалифицирован. Raw logs unit-pose/positive в private project;
часть309bfbb исключена как decode внутри инструкции, valid getter branch309bfc6 проверен отдельно.
Actual Actor producer3093bd0 использует27eaa60/28502e0→unit handle→Actor+160; registry291e160 не
type-specific factory. Constructor/vptr ветки PreviewerModel теперь установлены (см. ниже).
Owner+1d8 scene angle влияет и на position (с owner translation+1cc/+1d0/+1d4), и на rotation.
Найден context constructor3063c80: owner translation поступает пятым аргументом, angle шестым.
Raw whole-function decode893eb0/108adf0/108caf0 показывает angle0 во всех трёх creation branches.
Это исключает постоянный scene-default -90 на этих путях, но не квалифицирует все callers.
Explicit sceneRotation в public Arrival XML отсутствует; final unit→M3 basis ещё не доказан.
Не подставлять -90 только в quaternion и не путать Actor+1d8 boolean с owner+1d8 angle.

Literal actorZ+90 эксперимент отклонён actual public MCP Arrival315000 PNG1920x1080, models16/16:
arrival-315000-native-bearing-public-mcp.png949304B, SHA256
ba8bc27f9d347398b2ba25b0c4d970703e4ad5b151a88fcd64d22385539363a1.
Декорация полностью перекрыла камеру. Только экспериментальные source/test hunks убраны,
committed Euler981cd3c1 и предыдущие owned RTT/opacity/selectors сохранены. Private world.js
восстановлен узкой компиляцией; restored-euler-only-compile-receipt.json. Этот PNG не приёмка.
Arrival WebP480x270,8frames/4fps/2s не создан: ffmpeg wallclock180s истёк, пока CPU производил
кадры. Процесс/дети завершены. Не обходить ограничение unbounded raw movie или вторым encoder.

Media strictTS slice принят NEW3 Integrator01a13cc4-0402-7cc1-b692-36e6202b3372 и Core:
C:/MKTEMP/cutscene-media-typed-20261015/media-owner.patch, owner-patch-receipt.json,16точных путей.
HEAD-based apply--check PASS, old6owned untracked JS/d.ts перечислены с hashes для замены.
Один HostRGBA streaming/backend, GIF/WebP/OGV format wrappers strictTS→dist, public paths прежние.
Review исправил borrowed buffer и premature exit0: Buffer copy + последовательный write callback,
inputComplete только после validated EOF; pending producer next нельзя forcibly cancel, return
запрашивается без обещания завершения. Factory timeout фиксируется при создании.
Independent strictTS PASS,9RGBA tests +3existing decoder regressions PASS/0skips; свежий private
emit/public self-import/codec identity и npm pack closure PASS. Независимый Pillow/ffmpeg decode:
3RGB frames32x24/5fps,200ms каждый/600ms, encode/decode/package-files-receipt.json.
Не полный Core build и не native fidelity. NEW3 разрешил source landing exact16, все16liveSHA
совпали с candidate;39foreign tracked hashes сохранены. Concurrent Minecraft untracked test появился
по своему GO и не тронут; шесть owned obsolete wrappers сохранены recovery copies и удалены.
Live strict noEmit PASS, original9encoder+3decoder tests PASS/0skips. Core commit23883870c4377fcb2f14ff7e0df6ba854f2030fc,
parent4bc0d106249f7d6d51f5cde83c0abbeb556cfe31, exact16paths/ownclean/indexempty; window released.
Во время concurrent source work отдельно изменился foreign voxel.ts; его правки сохранены и
отражены в commit-receipt.json, не заявлять неизменность всех чужих исходников за весь интервал.
Shared dist/vendor/frozen artifact не обновлялись; cinematic RTT/scene/Three closure в commit не входят.
Receipt post-live-landing.json/live-check-receipt.json/commit-receipt.json. HEAD patch уже применён.

CPU cost diagnostic на saved public Host Arrival bundle (154prepared model entries, active frame,
не fresh MCP benchmark):480x270 adapt2.5ms/plan2824ms/render17472ms. Profile self samples:
standard-program.shade2655ms, texel1171ms, shadeMaterial937ms/read906ms/layerTexel886ms,
finiteVector800ms; startup/open включён в профиль, не считать его raster временем.
arrival-480-existing-render-cost.json, arrival-480-existing.cpuprofile, arrival-480-profile-summary.json.
Private array-free bilinear experiment отклонён:44208exactfloat/RGBA comparisons,6original filtering
tests и changed-function strict PASS, Arrival518400RGBA bytes identical, но6paired warm sampler
замеров не дали стабильного ускорения. Full-frame before11.2s/after20.7s observational/confounded;
их нельзя использовать как controlled performance claim. Original private sampler TS+JS восстановлен
из byte-identical backups; candidate сохранён отдельно, live Core renderer не менялся.
Decision texture-sampling-decision.json и benchmark/equivalence receipts в MKTEMP.
Следующий bounded performance slice — compilePass sampled invariants, только после owner review;
не добавлять второй shader/renderer и не объявлять saved154 bundle идентичным MCP16 acquisition.
Приёмка открыта: правильный Arrival PNG/WebP и Raynor RTT ещё не получены. Дальше проверить полный
actor/M3A/camera frame и подключить local material lighting; не добавлять guessed .5/+90.

Public Host native light evidence15.10: scene-at315000 Arrival выбирает ActiveLight
SMX2CutsceneEpilogue01Arrival,53authored Light nodes; Mission1489/2237 выбирает
SMX2CutsceneMissionEpilogue01,48authored nodes и1RTT. Это не число одновременно активных:
нужны ActiveShot/clip/attachment/visibility semantics. Native frame completeness остаётся partial.
MCP JSON projection scene-at capped, retainOutput JSON не поддержан; полные native samples
получены через public Host session.operations().invoke, каталоги через public ContentSources
openModContext + data.entities. Файлы и SHA: C:/MKTEMP/cutscene-fidelity-20261014/context-light-evidence.json.
Arrival CLight ambient[.047059,.121569,.380392], global diffuse intensities[.164,.047,0].
Mission CLight ambient[0,0,0], global diffuse intensities[0,0,0], AmbientEnvironmentMultiplier.025.
Поэтому общий global rig bridge не заменяет локальный point/spot light path. Не конвертировать
53/48 local lights в искусственные directionals; CLight extraction остаётся SC2 Maps shared helper.

Frame lighting SOURCE GO от NEW3/Core: только sdk/maps index+test, ui/world index+test.
Добавлен WorldSceneFrame.lighting и canonical admitWorldSceneLighting через Core.snapshotJson,
candidateWorldWebGlInput заменяет ВСЕ static lighting items на owned sample, omission возвращает
static facet; остальные world данные/камеры/poses/RTT не меняются. Helper сохраняет неизвестные
JSON metadata и существующие disabled/zero/AO epsilon/negative fog semantics; bounds settings-only,
не доказательство всех shader intermediates. Explicit directional profile UI=3, без truncation.
Core source commit addc1d28888c80680af95544bc1efab4bca661a2, parent43fabb1b, exact4 lighting-only,
принят actual Core/NEW3 review. Baseline private source d9001c0; old owned opacity/RTT16строк
сохранены в live и исключены из C:/MKTEMP/cutscene-frame-lighting-20261015/lighting-only.patch.
Private clean committed HEAD source closure не содержит этих старых WIP; shareddist/vendor не менялись.
CPU fixture квалифицирует ambient object/terrain rigs и emitted-ray/native-axis policy; existing
previewLighting имеет diffuse floor.25, обратный луч даёт64/255 вместо чёрного. Empty global
directional[] existing renderer включает default white key; helper не подменяет это zero light.
У Mission три явно записанных нулевых global sources, так что этот fallback не нужен.
Final private strict/noEmit exit0,358clean source files/0escaped workspace sources;58tests PASS/0skips
(SDK38/UI20), Integrator independent60PASS с двумя своими regression checks. Terrain408red pixels,
object168blue. Native-axis/UVW
оба дают front168bright/energy42840/RGB[0,0,255], rear0bright/10752/[0,0,64]. Qualification.json
фиксирует own4SHA/rendererSHA;22foreign hashes не изменились, index пуст. Commit receipt проверяет
все четыре committed blobs против privateclean CRLF→LF byte-content и Git OID без filters,
raw live4SHA неизменны, old16 payload идентичен; tests clean, window released. Не заявлять raw
CRLF SHA равным Git LF blob или git hash-object --path filter equivalence: последний claim отозван.
Ревью исправило enum String coercion и float32 log(exposure+1) denominator; regressions включены.
Без GPU/native acceptance claim.
Production SC2 CLight adapter/pointspot ещё не подключены.
Actor catalog lookup native references уточнены: original FUN7ff741d36420/FUN7ff741d36490 имеют
RVA bd6420/bd6490 при базе7ff741160000. Пробу1d36420/1d36490 исключить: это другой код и не
доказательство resource lookup. Corrected raw logs actor-catalog-corrected.log; Actor+1e8/+1f0
descriptor semantics ещё не квалифицированы.

Общая spatial-light math A принята Core/NEW3: commit c92395e3a384f91cedd725e5a09ca34e657f7082,
parent addc1d28, только scene/render/preview-lighting.ts и его существующий JS test. Один owner
sampleLightGeometry/LIGHT_GEOMETRY_GLSL выделяет vector/distance/attenuation; старые preview
floor.25/clamp/average, admission, binder и limit4 не меняются. Existing8tests PASS/0skip,
10000seeded CPU cases/30000float64 совпали точно; actual Intel ANGLE WebGL2:25cases before/after
RGBA bytes/uniform schema/binder calls identical, GL errors0. Прямой scene Node test runner
подхватывает JS; root Vitest/full этот JS не включает. Private SDK/Core declarations получены из
того же clean HEAD с собственными flags; Scene port-strict before/after PASS. Naive combined
source config даёт одинаковые62pre-existing SDK TS4111 before/after, не прятать их как PASS.
Receipt C:/MKTEMP/pointspot-math-20261015/qualification.json и commit-receipt.json;24foreign tracked
hashes сохранены, own2clean/indexempty/window released. Это geometry-equivalence, не M3/native light.

B material point/spot и C world/SDK locals ещё HOLD. Предложение B: existing BRDF owner повторяет
только direct diffuse/specular; ambient/environment/emissive/alpha вычисляются один раз. Core
потребовал отдельный explicit default-off geometry-needed флаг в material-geometry.ts (седьмой
production path): materialWorld/worldToMaterial position не равна scene-world position. Не включать
фиктивно environmentEnabled/worldShading ради TBN. Existing cofactor/handedness/GramSchmidt и
v_sceneWorldPosition переиспользовать, directional omission неизменен. Нужны actual CPU/GPU
normal-map point/spot, mirrored/nonuniform/skin/instance и nonidentity worldToMaterial checks до GO.

Native PreviewerModel path15.10: public ContentSources/data.entities подтвердил Actor/PreviewerModel
actualtype CActorModel→CActorBearings. Raw registrar1c5b30: type4, entry4*2180=8600,
ctor callback281a2f0→280f190, size7a0, vptr38f3118. Actual virtual+300→2869aa0 копирует quat
в actor+3d8; +308→44a4a0 false; +2f8→2836160 fallback→2869c00 копирует quat в actor+3bc.
+2d8→281e530 возвращает этот quat, hosted refresh условен. Derived virtual+548→283d4b0
передаёт actor+680 в model instance setter1d45280: no-parent branch копирует quat в instance+50,
parent branch учитывает inverse parent. Matrix update1d456e0 и owner dispatch1d4e5e0 используют
existing TRS builder1d3e450→quat conversion65c890. В этих copy/no-parent paths не найден -90,
но это не доказательство всех initialization/hosting/animation/render branches. Linear decode
281dc50 содержит opaque branches/bad instruction data: whole pseudocode не квалифицировать.
Installed Editor identity и полный native frame пока не доказаны. Receipt с13input hashes:
C:/MKTEMP/cutscene-fidelity-20261014/actor-model-publication-evidence.json. Production rotation
не менялась. Saved Raynor root/helmet/neck/head имеют явные rotation animation channels;
гипотеза missing M3A channel→identity этими данными не подтверждается.

Повторная сверка MCP-Codex по просьбе владельца (15.10): после907c0c03 все16 Arrival315000
actor-root matrices совпадают с ранее исполненным original reference actorAt, max4.45e-16.
Receipt C:/MKTEMP/cutscene-codex-comparison-20261015/postcurve-comparison.json; сравнение
saved frame, не свежий MCP/GPU и не native parity. Отдельно original reference parser/kernel
исполнен для Mission1489 с filters[red,win], Guide=true:16roots совпали max3.34e-16,
receipt mission-1489-roots.json в том же каталоге. CModel intrinsic scale повторно не разрешался.
Следовательно root placement MCP-Codex не является готовым исправлением оставшегося facing.
Reference kernel дополнительно исполняет bone LookAt/attachments/global clips, environment.ts
проецирует node/model lights, gpu.ts применяет ambient cube/local light/HDR postprocessing.
Это кандидаты для существующих model/Scene owners, не основание копировать второй renderer.
Reference local selection ограничен32/8 и rank-by-energy/distance; cone shader cos(full angle)
расходится с отдельно квалифицированным native cos(angle/2). Без engine comparison не переносить.
В Arrival315000 при filters[] строгие окна LookAt активны у Kerrigan/Selendis, у Raynor/Artanis
не активны; это не проверка StopLookAt fade и не доказательство причины поворота Рейнора.
Models cache-only raw CMS pass alpha init1 для07MATM2/5 подтверждает UVM1/1, receipt
C:/MKTEMP/m3-global-sequence-source-20261015/armyroom07-cms-alpha-cache-evidence.json.
Dynamic alpha/standard flags требуют отдельной проверки; Models выполняет bounded saved-binary
read без game/GPU/build. Core Models запрошен об existing generic model-gaze owner.
Core finder ответил: existing codec-kit/model-math/humanoid.ts solveTwoBoneIk — bounded limb IK,
не gaze executor; готовый generic bone-aim execution не найден. Не подменять его camera.lookAt
или asset-default UVM: cross-actor target/time/style принадлежат scene/cutscene. Receipt
C:/MKTEMP/uvm-uvw-requirements-20261014/bone-aim-existing-owner-review-20261015.json.
Сводка сравнения: C:/MKTEMP/cutscene-codex-comparison-20261015/review-20261015.md.

Новые факты15.10: public MCP refresh с committed907c0c03 в отдельном
C:/MKTEMP/cutscene-curve-mcp-20261015 завершён PASS; PNG1280x720/16of16models SHA
05b4df3fff75e84697b66c70015c40fff7e72da04c02abf8c2d10e18524eaea0; WebP256x144/4unique
500msframes/2s/16of16 SHA4599465aec104c15e3fd315ca9ee2bb65f4a8859c944dcaa7700fc821803fd4a.
Это private diagnostic, дефекты всё ещё видны. Shared builds/source не менялись.
Whiteout original GetMeshes/VertexBuffer.getUVs для07 дал точныеindices, позиции max5e-9,
UVmax5e-8 (JSONprecision);4reference meshes=2composites×2children, не missing geometry.
Models подтвердил0static/dynamic CMSalpha loss у07; dynamic receiptb9aab363…; это не proof00.
Draw isolation выявил настоящий orange offender:00/model504431 MATM10/13 CMS pass1,
normalDDS→opaque envi-color. Pass0=0orange, pass1=2279/2420 в160x90; receipt
C:/MKTEMP/cutscene-batch-layers-20261015/armyroom00-pass-coverage.json SHA
aed87d6a316af88ed0b3874761c7de136d744da305b57f0f8266561bd779c7ef.
Models/Core приняли localization; Models finder/PRE нашли риск writer: REF_/CMS tables не
сохраняются residual, filtering меняет ordinal; simple omission не признан безопасным. Owner
design в работе, live стандартный материал не менялся. Cutscenes ACK только REF_ slice при
сохранении existing LAYR RTT payload SHA4cfb7b52…; source/window согласует Integrator.

Пользователь затем обновил reference:1488fa9/v42. Index refreshed persistence=false,
references readonly. Старое all16rootmatch относится ТОЛЬКО кfc0b9a6. Новое правило modelLink
native RxRyRz(z+90), absentrotation defaults-90, rawmodelPath unchanged; paired controls
original parser/kernel прошли; schema default независимо квалифицирован на нашем private image (см. текущий результат выше), без installed-build parity.
Private real-source rotation experiment/PNG в C:/MKTEMP/cutscene-codex-v42-20261015,
не production correction и не native parity. cameraAxes prioritizes boneY/no shear,
spot cone теперьcos(full/2), ambientcube uses independent scalar, ordinaryfamily HDR policy,
WhiteShift/tone/LUT добавлены. v42 docs честно отмечают incompleteCPU и нетengine acceptance.
FIDELITY_PLAN обновлён текущими приоритетами reflection→rotation→RTT→lighting→postprocess.
