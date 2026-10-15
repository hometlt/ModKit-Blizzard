# Отчёт агенту-интегратору: модуль SC2 Cutscene

Дата: 2026-09-15. Автор: сессия, проверявшая `AGENT_HANDOFF.md` и продолжившая план модуля.

> **Внимание.** С ~22:00 файлы модуля параллельно правил второй писатель (вероятно, копия этой же
> сессии после перезапуска приложения). Свою работу я остановил. Перед интеграцией сверьте diff
> каждого файла ниже — изменения двух писателей могли смешаться.

## 1. Мои задачи

1. Проверить состояние codec/provider и корректность плана в `AGENT_HANDOFF.md`.
2. Исправить подтверждённые баги P0 провайдера (по согласованию с владельцем).
3. Определить политику rename при неполном workspace (владелец: «как в банках»).
4. Продолжить план модуля до завершения: оставшийся P0, семантика формата (P2: R2, R3),
   MCP e2e, dependency resolution, structural edits, preview.

## 2. Проделанная работа

### 2.1 Ревизия (без изменений кода)

- Гейты из handoff перезапущены: typecheck, vitest (33 теста, корпус реально прогонялся, не skip),
  `test:smoke`, `contributions:check` — зелёные. В handoff было неверно указано число тестов
  («32 + 5» вместо 28 + 5).
- Probe на собранном `dist` подтвердил 5 багов провайдера, см. 2.2.
- Найдены неточности плана: P0 «проверить colorProvider» уже сделан; LSP smoke проверял
  definition в одном файле, а не в двух; критерий «isIncomplete для rename» противоречит SDK
  (`LanguageWorkspaceEdit.isComplete: true` — литерал).

### 2.2 Исправлено в P0 (с тестами)

| Баг | Исправление | Файлы |
|---|---|---|
| Rename GUID не правил `referenceGuid` во включающих файлах и правил посторонние GUID в других файлах | GUID принадлежат документу; межфайловая ссылка только `referenceGuid` + непустой `referenceFile`; definition/references/rename/completion считают владельца | `providers/language/src/language.ts` |
| `objectGUID` (88 ссылок, `CCutsceneElementRTTChannel`) не считался ссылкой | добавлен в `REFERENCE_ATTRIBUTES` | `codecs/cutscene/src/validate.ts` |
| Диагностики указывали на первый попавшийся атрибут, найденный regex по тексту сообщения | валидатор отдаёт `CutsceneFinding.location` (offset элемента + атрибут); в report добавлены `start`/`starts`, `unknownTagStarts`, `externalCutsceneStarts` | `validate.ts`, `language.ts` |
| `finalNewline: false` возвращал пустой edit | используется общий `finalNewlineFormatting` из `shared/language/code-actions.js` | `language.ts` |
| Color presentation превращал RGB в RGBA | число компонентов сохраняется | `language.ts` |
| Поиск start-tag по элементу был O(n) на вызов | Map `startTagBySourceStart`; `analyze` на 3 МБ файле 1,3 → 0,7 с | `language.ts` |

**Политика rename (решение владельца «как в банках»):**
- полный workspace → объявление + локальные ссылки + `referenceGuid` во всех видимых включающих файлах;
- неполный workspace → правка только primary document (хост
  `modkit-core/packages/host/src/language/workspace.ts:1315-1330` отклоняет чужие документы);
- неполный workspace, но видимый документ включает этот GUID → отказ (иначе include сломается);
- неоднозначный владелец, повторное объявление или занятое новое имя → отказ.

Документация обновлена: `AGENT_HANDOFF.md`, `LANGUAGE_PROVIDER_PLAN.md`.
Проверено после правок: typecheck 0 ошибок, vitest 36/36 (включая корпус), `test:smoke` 8/8, probe.

### 2.3 P2: семантика формата — установлена по корпусу (2233 файла)

**R3 — `startLinkAttachToPoint` / `endLinkAttachToPoint`.** Редактор хранит абсолютное время рядом
с якорем. На якорях к целям с ненулевой длительностью:

| Якорь | Всего | = начало цели + distance | = конец цели + distance |
|---|---|---|---|
| start:1 | 3732 | 99,9% | 0% |
| start:2 | 744 | 0% | 99,9% |
| end:1 | 115 | 99,1% | 0% |
| end:2 | 183 | 0% | 100% |

Вывод: `1` = начало цели, `2` = конец, distance прибавляется. В корпусе встречаются только `1`, `2`
и отсутствие (по умолчанию `1`).

Реализовано: `timeline.ts` — убраны `AttachPointConvention`, параметр convention и
`attachPointEvidence`; неизмеренные значения разрешаются как `1` и помечают клип approximate.
Затронуты `codec.ts` (поле `convention` удалено из вывода `timeline`), hover и документация
атрибутов в провайдере, unit-тест.

**R2 — `curveInType` / `curveOutType`.** `curveInValue`/`curveOutValue` — это не tangent/weight,
а контрольные точки кубической Безье `(time, value)`; в автоматических режимах время контрольной
точки ровно на 1/3 интервала до соседнего ключа (Hermite → Bézier). Геометрия внутренних ключей:

| Тип | Признак | Доля | Режим |
|---|---|---|---|
| 3 | точка на прямой к соседнему ключу | 99,5–99,7% | linear |
| 4 | значение точки = значению ключа | 100% | flat |
| 5 | in/out коллинеарны через ключ, наклон Catmull-Rom; на экстремумах не выравниваются | 100% / 96–97% | smooth |
| 7 | как 5, но на экстремумах горизонтальны | 99,8% / 98,7% | auto (clamped) |
| 6 | время точки не на 1/3 | 23–48% на 1/3 | custom |
| 0, 2 | согласованной геометрии нет (0: ~1,7 тыс. сторон ключей; 2: 3 path marker) | — | не установлено |

Кнопки Curve Editor в `EditorStrings.txt`: Smooth, Auto, Linear, Slow, Step, Custom. Сопоставление
UI-названий с числами не доказано, поэтому режимы названы по геометрии. `0` может быть Step.

Реализовано в `curves.ts`: поля переименованы в `controlInTime/controlInValue/controlOutTime/
controlOutValue`; добавлены `tangentModeOf(type)` и `sampleChannel(channel, time)` — Безье с
бисекцией по времени; сегмент с неустановленным типом помечается approximate. Unit-тесты в
`cutscene.test.ts`.

Скрипты замеров (не в репозитории): scratchpad сессии, `semantics.mjs`, `semantics2.mjs`,
`semantics3.mjs`. Декомпилированный редактор (`references/SC2Editor1`) имён XML-атрибутов не
содержит — этот путь тупиковый.

## 3. Текущее состояние на диске (снято перед остановкой)

- `tsc -p starcraft2/tsconfig.sc2-cutscene.json` — 0 ошибок (тесты этим tsconfig не проверяются).
- `vitest starcraft2/modules/cutscene/test`: 27 passed (`cutscene.test.ts`, `language-provider.test.ts`).
- **`cutscene-corpus.test.ts` падает при загрузке**: `ReferenceError: walk is not defined`,
  `ATTACH_POINT_CONFIRMED` не объявлен. Это незавершённая версия второго писателя. Свой
  дублирующий блок (R3 + R2) я из файла удалил; корпусный тест для R2 с точными числами
  **не написан**.
- `docs/sc2-cutscene.md` (строки 34–35) всё ещё описывает `convention: 'unknown'` — не обновлён.
- Сообщение `EDIT_BLOCKED_REASON` в `codec.ts` и тест `opens a scene, refuses to edit it` всё ещё
  ссылаются на нерешённые `startLinkAttachToPoint`/`curveInType` — не обновлены.
- Ничего не закоммичено. `providers/`, `README.md`, `AGENT_HANDOFF.md`,
  `LANGUAGE_PROVIDER_PLAN.md`, `test/language-provider.test.ts`, `test/cutscene-lsp-cli.test.mjs`
  не отслеживаются git. `starcraft2/package.json` содержит также строку wizard provider другого агента.

## 4. Не выполнено

| Пункт плана | Статус | Что нужно |
|---|---|---|
| P0 LSP (semantic tokens, languageId по расширению, rescan, кэш, didChange/didSave) | не начат | зависит от вопроса 2 |
| P0 тесты CRLF / UTF-16 / одинарные кавычки | не начат | — |
| P0 дубли `REFERENCE_ROLE_BY_ATTRIBUTE` ↔ `refs.ts` `RULES`; ручной `KIND_ATTRIBUTES` | не начат | генерация из корпуса (`scripts/census.mts`) |
| Корпусный тест R2/R3 с точными числами | конфликт писателей | вопрос 1 |
| P1 MCP e2e | не начат | шаблон `modkit-core/apps/mcp/test/sc2-bank-language.test.ts`; учесть заметку «workspaceLanguageIds must include primary» |
| P1 dependency resolution (referenceFile через mounts, catalog, M3/M3A, sound, conversation) | не начат | host resolvers; `starcraft2/shared/language/catalog-resolver.ts` — кандидат |
| P2 structural edits | не начат | семантика теперь известна → решение по вопросу 4 |
| P3 preview | не начат | отдельная задача вне language provider |

## 5. Вопросы интегратору

1. **Два писателя.** Какая сессия ведёт модуль? Чья версия `cutscene-corpus.test.ts` остаётся?
   Проверьте смешение правок в `curves.ts`, `timeline.ts`, `cutscene.test.ts`, `codec.ts`.
2. **Отдельный LSP.** Решение владельца от 2026-09-04: generic LSP adapter, кодеки не поставляют
   свой LSP. `providers/language/lsp-cli.ts` ему противоречит, а `modkit-core/apps/lsp` уже умеет
   semantic tokens, выбор языка по расширению и watched files. Удалить `lsp-cli.ts`,
   `test/cutscene-lsp-cli.test.mjs`, bin `modkitx-cutscene-lsp`, строку в `test:smoke` и запись в
   `tsconfig.sc2-cutscene.json`, а cutscene добавить в `modkit-core/apps/lsp/test/installed-smoke.mjs`?
   Моё удаление заблокировал классификатор (handoff заявлял этот LSP как фичу). Файл
   `installed-smoke.mjs` сейчас правит другой агент (кейс SC2 Style).
3. **Уровень доказанности R2/R3.** Достаточно ли корпусных данных, или нужен контрольный прогон через
   SC2Editor (правило: копии без asset dependencies, никаких тяжёлых задач во время сессии редактора)?
   Особенно для UI-названий режимов и для типов `0`/`2`.
4. **`edit.structure`.** Семантика R2/R3 установлена. Снимать состояние `dependency-required` и
   начинать source-preserving structural edits, или оставить заблокированным до решения по
   edit-контракту (single writer path)?
5. **Смена публичной формы.** Удалены `AttachPointConvention`, `attachPointEvidence`, поле
   `convention` в выводе операции `timeline`; переименованы поля `CutsceneCurveChannel`
   (`tangentIn/weightIn/...` → `controlInTime/controlInValue/...`). Внешних потребителей в
   `starcraft2` нет (проверено grep). Нужна ли запись о breaking change?
6. **Корпус.** `cutscene-corpus.test.ts` жёстко привязан к `references/SC2GameData`, а не к game
   discovery (решение владельца: корпуса через discovery). Переводить сейчас или отдельной задачей?
