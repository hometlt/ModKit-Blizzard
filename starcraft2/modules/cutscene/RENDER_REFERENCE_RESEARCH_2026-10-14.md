# M3A, материалы, свет и RTT: результаты сверки

Статус на 14.10.2026: исследование и проверенный source-срез. Это не подтверждение
пиксельного соответствия SC2 и не готовая реализация RTT. Исходники в `references/`
используются только для чтения; второй parser, renderer или resource loader не добавляется.

## Полезные реализации

| Источник | Что проверять | Ограничение |
| --- | --- | --- |
| [WhiteoutFlakes](https://github.com/FernandoS27/WhiteoutFlakes), локально `references/WhiteoutFlakes` | `M3ModelAdapter::AttachAnimationFile`, `M3AnimTables::Build`: M3A/STG принадлежит своему файлу; общий animId связывает его с базовой моделью. Материалы и анимация — отдельные полезные оракулы | Авторы обозначают SC2 materials/animations как WIP, effects отсутствуют; готовность SC2Cutscene/RTT не подтверждена |
| [m3studio](https://github.com/Solstice245/m3studio) | M3A импортируется в существующий armature; соответствие animation IDs; LAYR source selectors | Blender-import округляет миллисекунды в 30 fps; это не точный playback oracle. GPL-код не переносится в MIT |
| [mdx-m3-viewer](https://github.com/flowtsohg/mdx-m3-viewer), локально `references/mdx-m3-viewer` | Persistent bone texture, обновление позы без пересоздания геометрии | Частичный M3; animated camera getter не является готовым оракулом |
| `references/open-realm-main/open-realm-main` | `r_m3_load.c`: CLight, направление луча, blend factors, CMS alpha; `AXIS.md`: базис и placed angle | Чтение RTT полей не означает наличие RTT camera passes; cutscene Euler/LookAt отдельно не подтверждены |
| [star-tools-three-m3-loader](https://github.com/sc2-arcade-watcher/star-tools-three-m3-loader) | Дополнительное сравнение model viewer/GLB | Его CLI прямо сообщает bind-pose вместо skinning для headless WebGL1; полноценным катсценным оракулом не считать |

В просмотренных реализациях не найден подтверждённый готовый SC2Cutscene-плеер,
включающий timeline, M3A, native scene lighting и RTT. Это ограниченный результат поиска.

## Подтверждённые расхождения и границы исправлений

1. Общий composite sampler заменяет alpha первого прохода на 1. Native M3 builder сохраняет
   CMS alpha. В public Host snapshot Arrival у Raynor обнаружены первые alpha 0.9 и 0.5;
   у пола и голограммы первые alpha равны 1. Исправление полезно, но пересвет пола этим не доказан.
2. Native glare actors Arrival имеют opacity 0.1/0.2 и tint RGB `[0, 0.588235, 1]`.
   Adapter теперь передаёт допустимый RGB через существующий `presentationTint`.
   HDR tint за пределами текущего контракта и fractional opacity дают диагностику;
   opacity ещё требует нейтрального поля и общей alpha classification у Core.
3. LAYR `video_channel` — signed selector `-1 | 0..6`, независимо от `uv_source`.
   MAT_ `rtt_channels_used` — dependency mask, не selector. Source mapping сохраняет канал,
   исходный bitmap fallback и mask отдельно; runtime material validator/RTT passes ещё отсутствуют.
4. Свет Arrival должен учитывать выбранный shot и CLight из общего Data context.
   Не подменять native point/spot средним directional light. Native light cone направлен по -Z;
   авторский ray direction и вектор surface-to-light имеют противоположный знак.
5. Не добавлять глобальный facing offset 90°: SC2 model basis и native placed angle уже
   взаимодействуют. LookAt и конкретный native cutscene Euler требуют отдельной проверки.

## M3A precision: следующий обязательный эксперимент

Различия с WhiteoutFlakes подтверждены в коде, но его комментарии о retail функции —
утверждения автора, а не независимая проверка Modkit:

- `MixTrack(quaternion)` использует raw component lerp без normalize/sign correction,
  а `MixLayers` — отдельный slerp. Наш evaluator использует shortest-path slerp;
  projection также корректирует hemisphere и публикует spherical-linear.
- Reference сортирует STC stable priority descending. Наш `resolveAnimRef` выбирает
  первый stored-order hit и сохраняет priority как metadata.
- Reference использует flag `0x10` для step и отдельную runtime-row оговорку.
  Наш extractor трактует header interpolation как step/linear. Это касается и material tracks.

В уже произведённом public Host snapshot Arrival `Stand` Raynor имеет 285/285 step channels,
из них64 с меняющимися key values; Kerrigan —603/603 step, из них586 с меняющимися values.
Artanis Stand —299 step из642, из них78 меняющихся. Это подтверждает значимость проверки,
но само по себе не доказывает ошибку: некоторые native tracks могут быть намеренно step.
Факты: `C:/MKTEMP/cutscene-render/arrival-animation-reference-facts.json`;
данные получены из сохранённого Host результата, без второго чтения game archives.

Проверить через existing Host/native model inspection: один attached M3A с header=0 без
flag 0x10; большой угол соседних quaternion keys; конфликт двух STC priorities; material
animRef с тем же режимом. Сохранить native значения и сравнить кадры Editor/игры.
Не исправлять общий UV sampler под недоказанную игровую семантику; при необходимости
точную игровую аппроксимацию готовит M3 owner и явно описывает её пределы.

## Порядок улучшений без второго рендера

1. Сначала native alpha/tint, active shot, CLight и material source selectors. Не лечить
   неверную семантику ручным уменьшением exposure или заменой текстур.
2. RTT: existing renderer выполняет ограниченные secondary camera passes для востребованных
   каналов 0..6. Pose/geometry/material programs переиспользуются; target textures/framebuffers
   сохраняются между кадрами. Запрет feedback loops, диагностика отсутствующей камеры/циклов,
   cleanup при смене сцены и отмене. Не читать каждый RTT в CPU и не кодировать его в PNG.
3. Размер RTT зависит от экранной площади и выбранного качества; обновление необходимо при
   изменении camera/time/resources. Статический канал можно переиспользовать лишь при полной
   проверке этих зависимостей. До измерения не обещать ускорение или конкретную частоту.
4. Сверить color spaces каждого слота. Освещение/композиция должны работать в согласованном
   linear space, вывод в sRGB — один раз. RTT не должен получать повторное output conversion.
   См. [Three.js color management](https://threejs.org/manual/pages/color-management.html).
5. Linear HDR intermediate `RGBA16F` возможен при
   [EXT_color_buffer_float](https://registry.khronos.org/webgl/extensions/EXT_color_buffer_float/);
   поддержка float MSAA проверяется отдельно. RGBA8 fallback объявляется ограничением.
   Native exposure/tone operator нужно установить; произвольный ACES не доказывает SC2 parity.
6. Только после этого — shadows/bloom/antialiasing и оптимизация измеренных hot paths.
   Native light count не означает, что все lights видимы/нуждаются в shadow pass.

## Проверка текущего среза

Независимый прямой Vitest: 35 Models tests (RTT15, binding8, sidecar12) и 25 Cutscene tests
(evaluate15, world10), exit0, без skips. Owner test patterns включают новые файлы.
Models RTT fixture проверяет source builder, не binary parser/GPU; cutscene — XML→evaluate→world.
Логи: `C:/MKTEMP/cutscene-render/{rtt-binding-independent-gate,tint-opacity-independent-gate}.log`.
До compiled Core dependency RTT consumer сохранён в
`C:/MODDING/parked/blizzard-formats/rtt-material/`: `standard-material.patch` и
`m3-rtt-material.test.ts`. Patch применим к текущему HEAD; новые сломанные type imports
не оставлены в рабочем дереве. Tint adapter остаётся в отдельном cutscene foundation.

Последний PNG `C:/MKTEMP/cutscene-render/arrival-315000-fullhd.png` был сделан **до** нового tint
mapping. Это diagnostic 1920×1080 на native315000ms, cameraMasterC, Artanis018 +1046ms;
16 выбранных объектов converted. Новый визуальный proof требует compiled owner prerequisites
и согласованного isolated Host/render прогона. Arrival содержит 0 RTT; RTT acceptance target —
`Cutscene_MissionEpilogue01Start`, экран разговаривающего Raynor.
