# Arrival: isolated Host profile и граница доказательств

Дата:14.10.2026. Для нового M3/M3A агента; это описание диагностического профиля,
не опубликованный acceptance bundle и не разрешение пересобирать чужой stage.

## Состояние исходников

Cutscene foundation **ещё не имеет landed commit/hash**. Codec/evaluator/world/SC2Scene/facial
consumer находятся в dirty/untracked foundation. Семь dirty Models paths остаются
MODKIT-CUTSCENES KEEP, как перечислено в TASK_M3_M3A_NATIVE_PARITY_2026-10-14.md.
Новый агент не копирует/правит/коммитит эти исходники для воспроизведения baseline.

Landed Models prerequisites: dfa6c896 (typed M3A admission), 22d9359b (duplicate onset),
07a85b6d (catalog model). Docs0d94cc34. Core HEAD на момент проверки8eeebb34 включает
F1/44b1d440 и RTT type/bcb9ca2c; это не означает публикацию F2/F3/F4 или обновлённого dist.
Разделение owner hunks: C:/MKTEMP/cutscene-render/FOUNDATION_OWNER_SPLIT_2026-10-14.md.

## Профиль, на котором получен диагностический baseline

| Параметр | Значение |
| --- | --- |
| Корень isolated artifacts | C:/MKTEMP/cutscene-render |
| Core runtime | core/packages/{host,sdk,codec-kit,scene,ui,uv,vfs,core}/dist и core/apps/mcp/dist |
| Extension roots | blizzard/starcraft2, blizzard/models, blizzard/casc, blizzard/mpq, blizzard/blizzard-common-formats; core/extensions/models, core/extensions/images |
| Установка | F:/GAMES/Blizzard/StarCraft II |
| moduleOptions | installationDirectory выше, cascOnline:false |
| ContentSources cache/storage | C:/MKTEMP/cutscene-render/{cache,storage} |
| Selected baseMods | Campaigns/VoidStory.SC2Campaign |
| Host input root | C:/MKTEMP/cutscene-render/inputs |
| Host options | trustExtensions:true, sharedModServer:false, outputArtifacts:true |
| Input | inputs/cutscene_epilogue01arrival.sc2cutscene, сохранён через public ContentSources |
| Native logical source | Campaigns/voidstory.sc2campaign/base.sc2data/cutscenes/cutscene_epilogue01arrival.sc2cutscene |
| Frame | timeMs315000, cameraMasterC, Artanis018+1046ms; native bookmark313954 |
| Source contract | common.view/world-scene-source@1 |

`trustExtensions:true` относится только к известным локальным first-party bundles этого профиля,
не является рекомендацией доверять произвольным сторонним расширениям.
Package versions Host0.1.0 и Models1.0.0 не идентифицируют содержимое compiled closure.
Stage исторически включал незакоммиченный foundation, поэтому нельзя присвоить ему один HEAD hash.
Перед новым прогоном сохранить фактические artifact hashes/paths и проверить inventory/activation.

## Драйверы и что каждый действительно проверяет

1. `arrival-prepare-host.mjs`: resolveContentSources → createHostMcpPort → host.open →
   session.dataSource → source.frame/page → inspectCandidateWorld. Это fresh Host acquisition,
   без чтения предыдущего prepared snapshot. Геометрия/анимации/материалы разрешаются существующим owner.
   Пишет arrival-prepared.bin, arrival-model-status.json, arrival-resources.json и frame JSON.
2. `arrival-repaired-host.mjs`: читает arrival-final-prepared.bin, заново загружает только failed
   active models и объединяет результаты. Это смешанный диагностический retry, **не fresh all-model proof**.
   maxConcurrentModelAcquisitions:1 помог Artanis/Selendis при неизменных внутренних deadlines.
3. `arrival-png.mjs`: читает prepared snapshot и frame JSON, вызывает common headless renderer/PNG encoder.
   Подтверждает рендер данного snapshot; **не выполняет новый Host resolve и не является MCP tool call**.
4. `render-mcp.mjs`/`fidelity-mcp.mjs`: примеры настоящих open_subject/world_scene/animation MCP calls
   через createModkitMcpServer и InMemoryTransport. Сейчас настроены на zLD_ArrivalChar/SwarmStory;
   не запускать их как будто это Arrival/VoidStory. Использовать только как harness pattern в своей
   MKTEMP-копии с изменёнными input/baseMods/time/output, после разрешённого artifact window.

Fresh acquisition и snapshot render нужно обозначать двумя разными этапами. Existing scripts могут
изменять общие MKTEMP outputs/cache; перед запуском согласовать окно и использовать отдельные имена
результатов/собственную копию harness. Не менять compiled stage, build-core.mjs/build-extension.mjs
или vendor самостоятельно. Полный committed Host proof ждёт coherent F2/F3/F4 и consumer release.

## Воспроизводимые команды существующего профиля

Только после согласования stage/window с INTEGRATOR. TEMP/TMP указываются на C:/MKTEMP.
Эти команды не запускаются автоматически из задания:

```powershell
$env:TEMP='C:/MKTEMP'
$env:TMP='C:/MKTEMP'
node C:/MKTEMP/cutscene-render/arrival-prepare-host.mjs
```

Проверить status всех active objects; cancelled/unresolved/failed не считать converted.
Старый prepare использовал default acquisition concurrency и мог отменить отдельные модели.
Для нового fresh harness допустимо использовать уже существующий inspector option
maxConcurrentModelAcquisitions:1, сохраняя те же resource/deadline/cancel budgets. Не заменять
ошибки результатами из старого snapshot для доказательства fresh all-model success.

```powershell
node C:/MKTEMP/cutscene-render/arrival-png.mjs arrival-prepared.bin 1920 1080 fresh-diagnostic
```

Вторая команда рендерит только результат первой. Если он partial, PNG также partial.
Она перезаписывает только отдельный PNG/report с tag fresh-diagnostic, но первая команда пишет
общие names; вместо неё новый агент должен выбрать свой output root в scratch harness.
Оба драйвера используют AbortSignal timeout30min для всего диагностического задания; внутренние
Host budgets не расширялись. Это не новая норма продуктового timeout и не основание его увеличивать.

Публичный MCP payload для согласованного Arrival harness:

```json
{"name":"modkit.open_subject","arguments":{"path":"C:/MKTEMP/cutscene-render/inputs/cutscene_epilogue01arrival.sc2cutscene"}}
```

После получения настоящего handle и discovery фактической schema:

```json
{"name":"modkit.world_scene","arguments":{"handle":"HANDLE_FROM_OPEN","view":"render","timeMs":315000,"camera":"source","width":1920,"height":1080}}
```

Handle не хардкодить; schema текущего опубликованного server должна допускать эти поля.
PNG из snapshot helper не выдавать за эту MCP операцию. WebP делать через exposed animation
operation только после проверки её time/camera schema и budgets; existing renderer/encoder не дублировать.

## Зафиксированные hashes и результаты

| Файл | SHA256 |
| --- | --- |
| inputs/cutscene_epilogue01arrival.sc2cutscene | df34af2755de4ef88dbf147b98a899b2671e09a3f56b48c93c7073d8acbda258 |
| arrival-prepare-host.mjs | 598fe23dd8d2e14230011bd9a89bb913f4decea555b07237f5ddc43d9d828414 |
| arrival-repaired-host.mjs | 206790ba2fd36388d5c557ff6733b3baa46239f047e7fa0879b9e538449f3c90 |
| arrival-png.mjs | 9fbfe9b6b99ee9dbc8b7042a58b0a99b8a9ba26388e2784e06e0aff12710859d |
| arrival-315000-fullhd.png | 242dac952bbc7210811be3bffb4a477dd0fa43bb376be82d8c371a8279ff706b |

Последний PNG1920×1080,16 active objects converted после selective retries; это mixed-stage
diagnostic, не clean HEAD/native parity. Он сделан до последнего tint mapping. Body/eyes M3A
подключены; interpolation ещё исследуется. FaceFX/LookAt/native lighting/postprocessing не полные,
пол/голограмма пересвечены, facing отличается. Arrival не содержит RTT.

Model facts: arrival-repaired-status.json, arrival-animation-reference-facts.json,
arrival-material-facts.json. Один DDS SM_RaynorGun_Diff.dds отсутствует; подмен не было.
Baseline pose/TRS и material receipts полезны для M1a без передачи dirty consumer paths.
Успешный ретрай или наличие старого PNG не закрывает свежую product-route проверку.
