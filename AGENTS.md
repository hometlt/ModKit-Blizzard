# modkit-extensions-blizzard — правила для агентов

Сначала прочитай общий свод правил рабочего пространства: `../AGENTS.md`
(в корне рабочего пространства). Этот файл только дополняет его для расширений Blizzard.

## Что здесь

- `starcraft2/` — одно расширение StarCraft II. Модули `starcraft2/modules/<область>`:
  banks, campaign, cutscene, data, galaxy, game, layout, map, mod, replay, runtime, strings, style,
  textures, triggers, wizard. Общий для игры код — `starcraft2/shared`. Где что уже реализовано —
  таблица в `../AGENTS.md` §4.3.
- `models/` — M3/M3A (`src/m3`, библиотека формата `src/m3/native`, `../AGENTS.md` §7.3).
- `mpq/`, `casc/` — контейнеры Blizzard; ими открываются карты, моды, реплеи и установка.
- `blizzard-common-formats/`, `blizzard-diablo/`, `blizzard-warcraft-3/` — прочие форматы.
- `vendor/modkit-*.tgz` — закреплённые пакеты ядра. Изменения ядра приходят только через vendor hop.
- `architecture/mk3-legacy-imports.json` — храповик legacy-импортов (только сокращать).

## Не терять и не пересоздавать

Перед новой возможностью и перед удалением или заменой кода — порядок из `../AGENTS.md` §4.0:
искать по каталогу §4.3–4.5, манифестам, сверке `modkit-core/reports/parity/sc2-pending-audit-2026-09-24.json`
и `git grep`; удалять только с заменой и тестом; найденный неописанный функционал дописывать в каталог.

## Владельцы

- `starcraft2/modules/triggers` и связанные бенчмарки — сессия [SC2] Triggers. Изменения там и
  пересборку `dist` во время её прогонов согласуй с ней.
- Загрузчик модов (`modules/mod/shared/workspace`) — единственный путь к контенту модов
  (`../AGENTS.md` §7.2). Не добавляй свой.

## Сборка и проверки

- `pnpm build` — весь `dist` и портативные бандлы (меняет файлы, на которых работают VS Code и
  бенчмарки — предупреди).
- Типы: `pnpm typecheck` или нужный `starcraft2/tsconfig.*.json` с `--noEmit`.
- Тесты: `npx vitest run --config test/vitest.config.mjs <пути>`; уровни —
  `MODKIT_TEST_TIER=quick|owner|real` (`real` — установленная игра, `MODKITX_SC2_ROOT`).
- Гейты: `pnpm run contributions:check`, `test:module-map`, `check:codec-provider-split`,
  `check:mk3-boundaries`, `check:operation-parity`, `test:inventory`, `test:subjects`,
  `test:behavior-coverage`, `test:ownership`, `test:tiers`, `test:smoke`.
- Важное архитектурное изменение — строка в журнал `../AGENTS.md` §10.
