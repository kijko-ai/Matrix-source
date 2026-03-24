# Kanban Design

## Flow

```
TODO → IN PROGRESS → DONE → [юзер] → REVIEW → [юзер] → APPROVED
                       ↑                  |
                       └── Fix (error) ←──┘
```

## Колонки

| Колонка | Source | Кто двигает | Описание |
|---------|--------|-------------|----------|
| **TODO** | task.status = pending | Автоматически | Задачи ожидающие исполнителя |
| **IN PROGRESS** | task.status = in_progress | Автоматически | Агент работает |
| **DONE** | task.status = completed | Автоматически | Агент завершил |
| **REVIEW** | kanban-state.json | Юзер (drag-and-drop) | На проверке |
| **APPROVED** | kanban-state.json | Юзер (drag-and-drop) | Одобрено |

---

## Kanban State Storage

### Почему свой файл, а не task metadata

Metadata в task-файлах может быть **перезаписан** агентом при TaskUpdate. Semantics (merge vs replace) НЕДОКУМЕНТИРОВАН. Если replace — наш kanbanColumn исчезнет.

### Формат kanban-state.json

Хранится в директории app config (не в `~/.claude/tasks/`).

```json
{
  "teamName": "my-team",
  "reviewers": ["agent-review-1"],
  "tasks": {
    "12": {
      "column": "review",
      "reviewStatus": "pending",
      "reviewer": "agent-review-1",
      "movedAt": "2026-02-17T15:30:00.000Z"
    },
    "15": {
      "column": "approved",
      "movedAt": "2026-02-17T16:00:00.000Z"
    },
    "18": {
      "column": "review",
      "reviewStatus": "error",
      "reviewer": null,
      "errorDescription": "Не обработан edge case с пустым массивом",
      "movedAt": "2026-02-17T16:30:00.000Z"
    }
  }
}
```

### Column Mapping Logic

```
Task → Column:
1. kanban-state.tasks[task.id] exists? → use .column
2. task.status === "pending" → TODO
3. task.status === "in_progress" → IN PROGRESS
4. task.status === "completed" → DONE
5. task.status === "deleted" → не показываем
```

### GC kanban-state (важно: порядок операций)

При очистке устаревших записей (задачи которых больше не существуют) **ОБЯЗАТЕЛЬНО** сначала полностью загрузить все tasks, и только потом запускать GC:

```typescript
// ПРАВИЛЬНО:
const tasks = await getAllTasks(teamName);       // 1. Сначала все tasks
const kanban = await getKanbanState(teamName);   // 2. Затем kanban
const validIds = new Set(tasks.map(t => t.id));
const cleaned = Object.fromEntries(
  Object.entries(kanban.tasks).filter(([id]) => validIds.has(id))
);                                               // 3. Только потом GC

// НЕПРАВИЛЬНО (race condition при startup):
const kanban = await getKanbanState(teamName);
gcStaleEntries(kanban);   // ← task-файлы ещё не прочитаны, удалим валидные записи
const tasks = await getAllTasks(teamName);
```

---

## Review Flow

### Перемещение DONE → REVIEW

1. Юзер перетаскивает карточку из DONE в REVIEW
2. Проверяем `kanbanState.reviewers[]`
3. **Есть ревьюверы**:
   - Берём первого свободного (round-robin с балансировкой по количеству активных ревью)
   - Записываем в kanban-state: `{ column: "review", reviewStatus: "pending", reviewer: "agent-name" }`
   - Отправляем inbox ревьюверу:
     ```json
     {
       "from": "user",
       "text": "Please review task #12: Rename package in pubspec.yaml\n\nDescription: Change name: dartdoc to name: dartdoc_vitepress",
       "summary": "Review request for task #12",
       "timestamp": "...",
       "read": false
     }
     ```
4. **Нет ревьюверов**:
   - Записываем в kanban-state: `{ column: "review", reviewStatus: "pending" }`
   - Юзер сам ревьювит через UI (кнопки OK / Error)

### Review Result

В UI каждая карточка в REVIEW показывает ReviewBadge:
- **Pending** (yellow) — ждёт ревью
- **Approved** (green) — проверено, всё хорошо → кнопка Approve → переходит в APPROVED
- **Changes Requested** (red) — найдены замечания → кнопка Request Changes с опциональным комментарием

### Approve → APPROVED

Юзер нажимает кнопку **Approve** на карточке в REVIEW:
- kanban-state: `{ column: "approved" }`

### Request Changes → Fix

1. Юзер нажимает кнопку **Request Changes** на карточке в REVIEW
2. Появляется ReviewDialog — textarea для описания проблемы (опционально)
3. Юзер нажимает "Отправить"
4. Действия:
   - kanban-state: удаляем запись для этой задачи (вернётся в IN PROGRESS по status)
   - task file: `status = "in_progress"` (atomic write)
   - Inbox к исходному owner:
     ```json
     {
       "from": "user",
       "text": "Task #12 needs fixes:\n\nНе обработан edge case с пустым массивом\n\nPlease fix and mark as completed when done.",
       "summary": "Fix request for task #12",
       "timestamp": "...",
       "read": false
     }
     ```

**Примечание**: `reviewHistory` (история раундов ревью) и round-robin балансировка ревьюверов — в Phase 2, не MVP.

---

## MVP vs Phase 2

### MVP: Click-to-Move

Для MVP вместо drag-and-drop используется **click-to-move**: каждая карточка имеет кнопку или select-dropdown для смены колонки. Это проще реализовать и достаточно для первой версии.

```
[Task Card]
  Subject: Rename package in pubspec.yaml
  Owner: worker-1
  [Move to: REVIEW ▼]   ← dropdown или кнопка
```

Разрешённые переходы через click-to-move:
| Откуда → Куда | Действие |
|----------------|----------|
| DONE → REVIEW | kanban-state: review + reviewStatus: pending. Inbox ревьюверу если есть |
| REVIEW → APPROVED (Approve) | kanban-state: approved |
| REVIEW → DONE (Request Changes) | Dialog → task: in_progress, kanban: remove, inbox к owner |
| APPROVED → DONE | kanban-state: remove (возвращается в DONE по status) |

Не разрешено:
- TODO → IN PROGRESS (агент берёт сам через TaskUpdate)
- IN PROGRESS → DONE (агент завершает сам через TaskUpdate)

### Phase 2: Полноценный D&D через @dnd-kit

`@dnd-kit` уже есть в зависимостях проекта (используется для перетаскивания табов). В Phase 2 добавить drag-and-drop для всех разрешённых переходов.

---

## Синхронизация при изменении task status

Агент может поменять статус задачи пока мы показываем Kanban. Через file watcher мы узнаём об изменении.

### Сценарии

**Task в REVIEW, но agent поставил status = in_progress**:
- Конфликт: kanban-state говорит REVIEW, task file говорит in_progress
- Действие: показать warning badge на карточке

**Task в REVIEW, agent поставил status = completed**:
- Агент завершил повторно (после fix)
- Действие: обновить reviewStatus на pending (новый раунд ревью)

**Новая задача (status = pending)**:
- Нет записи в kanban-state
- Действие: автоматически в TODO

---

## Reviewer Assignment

### Конфигурация

Список ревьюверов хранится в `kanban-state.json` → `reviewers: string[]`.

Источники ревьюверов:
1. **Роль при создании команды**: юзер в промпте указывает "создай agent-review с ролью reviewer"
2. **В UI**: кнопка "Назначить ревьювером" рядом с участником в MemberList

### Round-Robin с балансировкой

```typescript
function pickReviewer(reviewers: string[], kanbanState: KanbanState): string | null {
  if (reviewers.length === 0) return null;

  // Считаем активные ревью у каждого
  const reviewCounts = new Map<string, number>();
  for (const reviewer of reviewers) {
    reviewCounts.set(reviewer, 0);
  }
  for (const task of Object.values(kanbanState.tasks)) {
    if (task.column === 'review' && task.reviewStatus === 'pending' && task.reviewer) {
      const count = reviewCounts.get(task.reviewer) || 0;
      reviewCounts.set(task.reviewer, count + 1);
    }
  }

  // Берём того у кого меньше всего
  return [...reviewCounts.entries()]
    .sort((a, b) => a[1] - b[1])[0][0];
}
```
