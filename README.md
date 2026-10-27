# opencode-statusline

Кастомный TUI-статусбар для **OpenCode V2**:

- **Над полем ввода (`session.composer.top`):**
  - **Связанные открытые PR (`PR #360 ✓ 💬`)** — автоматически подхватываются по текущей ветке, вызовам `gh pr create|view|checks|edit|...`, упоминаниям в чате и ответам сабагентов. Показывается отдельно статус CI-чеков (`✓` / `◌` / `✗`) и статус ревью (`👍` аппрув или чистый AI Code Review, `👀` ревью в процессе, `💬` есть замечания). Номер PR — кликабельная ссылка.
  - **Запущенные агентом сборки TeamCity (`TC Prod_Release#20 ◌`)** — подхватываются при запуске через `teamcity trigger` или MCP `teamcity_rest_post` (только верхнеуровневая сборка без дочерних зависимостей, старые завершённые убираются), опрашиваются в фоне через TeamCity MCP и открываются по клику.
- **В нижней строке (`prompt.footer`):**
  - **Время работы ИИ (`⏱ 1m 24s (∑ 4m 10s)`)** — реальное (wall-clock с объединением пересекающихся интервалов) и суммарное время всех параллельных сабагентов (`∑`). Пауза на время ожидания ответа в `question` и подтверждения `permission`.
  - **Остаток бюджета LiteLLM (`$463/$500`)** — сразу после стоимости текущей сессии; меняет цвет на жёлтый при остатке `≤ 20%` и на красный при `≤ 5%`.
- **Уведомления WezTerm (OSC 777, в том числе сквозь `tmux`):** когда корневая сессия завершила ход, упала с ошибкой или ждёт подтверждения/ответа.

## Требования

- OpenCode V2
- Авторизованный `gh` CLI (`gh auth status`) — для отображения открытых PR
- Переменная окружения `LITELLM_API_KEY` — для отображения остатка бюджета LiteLLM и опроса TeamCity MCP

## Установка в одну команду

```bash
curl -fsSL https://raw.githubusercontent.com/Vovkt/opencode-statusline/main/install.sh | sh
```

Скрипт скачивает плагин в `~/.config/opencode/plugins/statusline/tui.tsx` (или `$XDG_CONFIG_HOME/opencode/plugins/statusline/tui.tsx`). OpenCode V2 подхватывает его автоматически на лету — перезапуск не требуется.

## Ручная установка (через git clone)

```bash
git clone https://github.com/Vovkt/opencode-statusline.git ~/projects/opencode-statusline
mkdir -p ~/.config/opencode/plugins/statusline
ln -sf ~/projects/opencode-statusline/plugins/statusline/tui.tsx ~/.config/opencode/plugins/statusline/tui.tsx
```
