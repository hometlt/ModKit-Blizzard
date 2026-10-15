# OpenRealm: применимость к M3/M3A и игровому качеству

Проверено 14.10.2026 чтением исходников. OpenRealm не собирался и не запускался;
native framebuffer parity и производительность не измерялись.

Локальная копия: C:/MODDING/references/open-realm-main/open-realm-main.
Graph project: open-realm-local-reference.
games/starcraft-2/renderer/m3/r_m3_load.c SHA256:
82738fae49d236ffd0cbf2d3e8b82557db19032aca095a83785f84d5a241410f.
Локальный файл имеет957 строк; прочитанный upstream-файл903 строки. Не смешивать их как одну ревизию.
Локальная LICENSE: MIT, copyright2024 corepunch. Workspace references остаётся read-only;
наличие MIT не разрешает обходить правила provenance и вендоринга.

[Upstream corepunch/open-realm](https://github.com/corepunch/open-realm) называет WarcraftIII основным
игровым target, SC2 — exploratory M3/SC2Map/SC2Layout. Это независимая реализация для сверки,
но не спецификация SC2 и не полный эталон катсцен.

## Проверенные функции и ограничения

В таблице номера строк относятся к локальному r_m3_load.c, кроме явно указанных других файлов.

| Область | Поведение локальной копии | Применение в Modkit |
| --- | --- | --- |
| Координаты | AXIS.md, sc2_coords.h, renderer/r_ents.c: M3 -Y front/+Z up; gameplay basis Rz90; placement heading raw-pi/2; portrait/native camera basis identity | Проверять точку применения basis. Нельзя добавлять global90° к моделям и камерам. Skinning остаётся в native space до общей трансформации |
| Кости | M3_MakeBoneMatrix:777 — parent×TRS; M3_RenderModel:824 строит pose×inverse bind в boneLookup palette | Проверка матриц и lookup; palette ограничена128. Не уменьшать Modkit region split до этого предела |
| Ключи | M3_FindAnimRef:484 линейно ищет ID; encoded ref0 трактуется как отсутствие. M3_FindKeyAtTime:495 использует unsigned keys/time. M3_GET_ANIM_VALUE:512 всегда передаёт TRACK_LINEAR | Не переносить граничные условия без проверки. Modkit обрабатывает signed lead-ins, duplicate keys и step tracks |
| Quaternion | games/starcraft-2/renderer/r_game.c, R_M3InterpQuat:92: default slerp. Между old/new poses в M3_RenderModel также slerp | Противоречит WhiteoutFlakes raw lerp между ключами. Это не два независимых подтверждения одного алгоритма |
| STC/SEQS | M3_FindSequenceTimeline:799 выбирает первый STC по stsIndex; M3_FindAnimationAtTime:809 последовательно раскладывает time по sequences | Упрощённый model playback; не доказательство полных STG ownership/priority/concurrent semantics |
| Цвет слоя | M3_LayerColor:568 берёт static color.initValue, полностью нулевой RGBA заменяет white | Не применять white fallback к authored black/transparent. Animated material color этим путём не подтверждён |
| Материалы | M3_DrawRegionMaterial:686 в основном использует diffuse; spec/gloss/normal читаются loader | Прочитанное поле не означает исполняемую shader feature. Полную нормаль/specular/HDR поддержку этот путь не доказывает |
| Emissive | M3_DrawEmissiveLayer:659 — дополнительный unshaded GL_ONE/GL_ONE pass, без depth write, пропускает shadow pass, переиспользует pose | Полезна организация проходов; не доказывает все native emissive ops/factors/color spaces |
| Composite | M3_DrawRegionMaterialReference:726 умножает incoming alpha на каждый CMS alpha.initValue, включая первый; recursion depth4 | Поддерживает необходимость сохранять первый alpha. Animated CMS alpha не проверена; depth4 — предел этой реализации |
| Blend | M3_SetMaterialBlendMode:579 устанавливает hardware blend/depth/cull state | Сверять RGB и alpha отдельно. Разные записи factors могут давать одинаковый RGB, но разную alpha |
| Свет | M3_SetLighting:70 берёт map CLight ambient/key и меняет знак ray direction для surface-to-light | Полезен источник и знак. Portrait ambient0.58/0.22 и key0.62 — workaround OpenRealm, не native SC2 параметры |
| RTT | Layer:246 читает rttChannel, Material:268 — usedRTTChannels. Scoped search не нашёл их дальнейшего исполнения в M3 renderer | Чтение формата не подтверждает RTT camera pipeline. Проверить другие ветки отдельно при необходимости |
| M3A/FaceFX | games/starcraft-2/game/hud/hud_unit.c:34 и hud-layout-pipeline.md отмечают TODO RequiredAnims.m3a/FacialController | Не считать OpenRealm оракулом готового M3A/FaceFX portrait playback |

## Что использовать и что проверить отдельно

Полезные направления: matrix/basis chain, bone lookup, blend и CMS alpha, знак CLight,
reuse bone palette между diffuse/emissive и запрет emissive в shadow pass.
Ограничения: unsigned keys, упрощённый timeline, static material values, ручной portrait light,
неподтверждённые M3A/RTT и полный material shader.

Coordinate tests описаны как math/production-route проверки без GL. Это не framebuffer сравнение
TRaynor01 или катсцены с Editor. Source review не является proof скорости или качества картинки.

Следующая сверка: native SC2 frame, текущий Modkit и конкретный reference algorithm с зафиксированными
версией/камерой/временем. Противоречие OpenRealm и WhiteoutFlakes по quaternion interpolation разрешать
native evidence; не голосованием реализаций и не слепым переносом одного из samplers.
