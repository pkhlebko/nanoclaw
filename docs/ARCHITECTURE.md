# NanoClaw Architecture

## System Overview

```mermaid
graph TB
    subgraph Users["Users"]
        WA_USER["WhatsApp User"]
        TG_USER["Telegram User"]
    end

    subgraph Host["Host Process (Node.js)"]
        subgraph Channels["Channels"]
            WA["WhatsApp Channel<br/><small>@whiskeysockets/baileys</small>"]
            TG["Telegram Channel<br/><small>grammy</small>"]
        end

        DB[("SQLite<br/>store/messages.db")]
        ML["Message Loop<br/><small>2s poll</small>"]
        MP["Message Processor"]
        GQ["Group Queue<br/><small>max 5 concurrent</small>"]
        CR["Container Runner"]
        IPC_W["IPC Watcher<br/><small>1s poll</small>"]
        SCHED["Task Scheduler<br/><small>60s poll</small>"]
        ROUTER["Router<br/><small>format & route outbound</small>"]
        STATE["App State"]
    end

    subgraph Containers["Docker Containers (per group)"]
        AGENT["Claude Agent SDK<br/><small>@anthropic-ai/claude-agent-sdk</small>"]
        MCP["MCP Server<br/><small>IPC tools</small>"]
        BROWSER["agent-browser<br/><small>Chromium + Playwright</small>"]
        CC["Claude Code CLI"]
    end

    subgraph Storage["Filesystem"]
        GROUPS["groups/{name}/<br/>CLAUDE.md, media/, logs/"]
        IPC_DIR["data/ipc/{name}/<br/>input/, messages/, tasks/"]
        SESSIONS["data/sessions/{name}/<br/>.claude/"]
    end

    CLAUDE_API["Anthropic API"]

    WA_USER <-->|messages| WA
    TG_USER <-->|messages| TG

    WA -->|storeMessage| DB
    TG -->|storeMessage| DB

    DB -->|getNewMessages| ML
    ML -->|routeGroupMessages| GQ
    SCHED -->|enqueueTask| GQ
    GQ -->|processGroupMessages| MP
    MP -->|formatMessages + runAgent| CR

    CR -->|"docker run -i<br/>stdin: JSON prompt + secrets"| AGENT
    AGENT -->|"stdout: streaming output"| CR
    AGENT <--> MCP
    AGENT <--> CC
    CC <--> BROWSER
    AGENT <-->|API calls| CLAUDE_API

    MCP -->|"write files"| IPC_DIR
    IPC_W -->|"poll messages/ & tasks/"| IPC_DIR
    CR -->|"write input/"| IPC_DIR

    IPC_W -->|sendMessage / sendMedia| ROUTER
    CR -->|onOutput| ROUTER
    ROUTER --> WA
    ROUTER --> TG

    AGENT <-->|read/write| GROUPS
    AGENT <-->|session data| SESSIONS

    STATE <--> DB

    classDef channel fill:#4a9eff,stroke:#2d7bd5,color:#fff
    classDef storage fill:#f5a623,stroke:#d4891a,color:#fff
    classDef container fill:#7ed321,stroke:#5ea318,color:#fff
    classDef external fill:#d0021b,stroke:#a30216,color:#fff
    classDef core fill:#9013fe,stroke:#7010c5,color:#fff

    class WA,TG channel
    class DB,GROUPS,IPC_DIR,SESSIONS storage
    class AGENT,MCP,BROWSER,CC container
    class CLAUDE_API external
    class ML,MP,GQ,CR,IPC_W,SCHED,ROUTER,STATE core
```

## Message Flow

```mermaid
sequenceDiagram
    participant U as User
    participant CH as Channel<br/>(WA/TG)
    participant DB as SQLite
    participant ML as Message Loop
    participant GQ as Group Queue
    participant MP as Message Processor
    participant CR as Container Runner
    participant CT as Container<br/>(Agent SDK)
    participant API as Anthropic API

    U->>CH: Send message
    CH->>DB: storeMessage()

    loop Every 2s
        ML->>DB: getNewMessages()
    end

    DB-->>ML: New messages
    ML->>GQ: enqueueMessageCheck(jid)
    GQ->>MP: processGroupMessages()
    MP->>DB: getMessagesSince()
    DB-->>MP: Message history
    MP->>MP: formatMessages() → XML
    MP->>CR: runContainerAgent()

    CR->>CT: docker run -i (stdin: JSON)
    CT->>API: Claude Agent SDK query()
    API-->>CT: Streaming response

    CT-->>CR: stdout: OUTPUT markers
    CR->>MP: onOutput(text)
    MP->>CH: sendMessage(jid, text)
    CH->>U: Deliver reply
```

## IPC Communication

```mermaid
flowchart LR
    subgraph Host["Host Process"]
        CR["Container Runner"]
        IPC_W["IPC Watcher"]
        SCHED["Scheduler"]
    end

    subgraph IPC["data/ipc/{group}/"]
        INPUT["input/<br/><small>follow-up messages, _close</small>"]
        MSGS["messages/<br/><small>send_message, send_media</small>"]
        TASKS["tasks/<br/><small>schedule, pause, resume, cancel</small>"]
        SNAP1["current_tasks.json"]
        SNAP2["available_groups.json"]
    end

    subgraph Container["Container (MCP Server)"]
        AGENT["Agent SDK"]
        MCP["MCP Tools:<br/>send_message<br/>send_media<br/>schedule_task<br/>list_tasks<br/>pause/resume/cancel_task<br/>register_group"]
    end

    CR -->|"write JSON files"| INPUT
    CR -->|"write snapshots"| SNAP1
    CR -->|"write snapshots"| SNAP2
    INPUT -->|"poll 500ms"| AGENT

    MCP -->|"write JSON files"| MSGS
    MCP -->|"write JSON files"| TASKS
    MCP -->|"read"| SNAP1

    IPC_W -->|"poll 1s"| MSGS
    IPC_W -->|"poll 1s"| TASKS
    TASKS -->|"CRUD"| SCHED
```

## Container Mounts

```mermaid
graph LR
    subgraph Host["Host Filesystem"]
        G["groups/{folder}/"]
        P["project root"]
        GL["groups/global/"]
        S["data/sessions/{folder}/.claude/"]
        I["data/ipc/{folder}/"]
        SK["container/skills/"]
        EM["extra mounts<br/><small>(allowlisted)</small>"]
    end

    subgraph Container["Container Filesystem"]
        WG["/workspace/group<br/><small>rw</small>"]
        WP["/workspace/project<br/><small>ro, main only</small>"]
        WGL["/workspace/global<br/><small>ro, non-main</small>"]
        HC["/home/node/.claude<br/><small>rw</small>"]
        WI["/workspace/ipc<br/><small>rw</small>"]
        WE["/workspace/extra/{name}<br/><small>ro/rw</small>"]
    end

    G --> WG
    P -.->|main group only| WP
    GL -.->|non-main only| WGL
    S --> HC
    I --> WI
    EM -.-> WE
    SK -->|"copied before run"| HC
```

## Database Schema

```mermaid
erDiagram
    chats {
        text jid PK
        text name
        text last_message_time
        text channel
        integer is_group
    }

    messages {
        text id PK
        text chat_jid PK
        text sender
        text sender_name
        text content
        text timestamp
        integer is_from_me
        integer is_bot_message
    }

    sessions {
        text group_folder PK
        text session_id
    }

    registered_groups {
        text jid PK
        text name
        text folder
        text trigger_pattern
        text added_at
        text container_config
        integer requires_trigger
    }

    scheduled_tasks {
        text id PK
        text group_folder
        text chat_jid
        text prompt
        text schedule_type
        text schedule_value
        text context_mode
        text next_run
        text last_run
        text last_result
        text status
        text created_at
    }

    task_run_logs {
        integer id PK
        text task_id
        text run_at
        integer duration_ms
        text status
        text result
        text error
    }

    router_state {
        text key PK
        text value
    }

    chats ||--o{ messages : "chat_jid"
    registered_groups ||--o{ scheduled_tasks : "group_folder"
    scheduled_tasks ||--o{ task_run_logs : "task_id"
```

## Task Scheduling

```mermaid
flowchart TD
    A["Scheduler Loop<br/><small>every 60s</small>"] -->|getDueTasks| B["SQLite: scheduled_tasks<br/><small>status=active, next_run ≤ now</small>"]
    B --> C{"For each task"}
    C --> D["GroupQueue.enqueueTask()"]
    D --> E["runContainerAgent()<br/><small>isScheduledTask: true</small>"]
    E --> F["Container executes<br/><small>[SCHEDULED TASK] prefix</small>"]
    F --> G["logTaskRun()"]
    G --> H["computeNextRun()"]
    H --> I{"schedule_type?"}
    I -->|cron| J["Next cron match"]
    I -->|interval| K["now + interval_ms"]
    I -->|once| L["null → completed"]
    J --> M["updateTaskAfterRun()"]
    K --> M
    L --> M

    N["Container MCP"] -->|"schedule_task IPC"| O["ipc-tasks.ts"]
    O -->|createTask| B
```

## Security Model

```mermaid
flowchart TD
    subgraph Secrets["Secret Handling"]
        ENV[".env file"] -->|"env.ts parser<br/><small>never sets process.env</small>"| STDIN["Container stdin JSON<br/><small>{secrets: {API_KEY, OAUTH}}</small>"]
        STDIN --> HOOK["Pre-Bash Hook<br/><small>unset ANTHROPIC_API_KEY<br/>unset CLAUDE_CODE_OAUTH_TOKEN</small>"]
    end

    subgraph Isolation["Container Isolation"]
        DOCKER["Docker --rm<br/><small>non-root node user</small>"]
        RO["Project root: read-only<br/><small>main group only</small>"]
        NS["Per-group IPC namespace"]
    end

    subgraph Validation["Mount Security"]
        AL["~/.config/nanoclaw/<br/>mount-allowlist.json<br/><small>outside project, never mounted</small>"]
        BP["Blocked patterns:<br/>.ssh, .gnupg, .aws,<br/>.env, private keys"]
        GV["Group folder validation:<br/><small>^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$</small><br/><small>no path traversal</small>"]
    end

    subgraph IPC_SEC["IPC Enforcement"]
        JID["Non-main: own JID only"]
        REG["register_group: main only"]
        TASK_SEC["Task ops: own group or main"]
    end
```

## Module Dependency Graph

```mermaid
graph TD
    INDEX["index.ts<br/><small>orchestrator</small>"]

    INDEX --> STATE["app-state.ts"]
    INDEX --> ML["message-loop.ts"]
    INDEX --> IPC["ipc.ts"]
    INDEX --> SCHED["task-scheduler.ts"]
    INDEX --> GQ["group-queue.ts"]
    INDEX --> CRT["container-runtime.ts"]

    ML --> MP["message-processor.ts"]
    ML --> GQ
    MP --> CR["container-runner.ts"]
    MP --> ROUTER["router.ts"]

    CR --> CM["container-mounts.ts"]
    CR --> CO["container-output.ts"]
    CR --> CRT
    CM --> MS["mount-security.ts"]
    MS --> MAL["mount-allowlist-loader.ts"]
    MS --> MPU["mount-path-utils.ts"]

    IPC --> IPC_T["ipc-tasks.ts"]
    IPC --> IPC_WR["ipc-writer.ts"]
    IPC --> ROUTER

    SCHED --> SU["schedule-utils.ts"]
    SCHED --> CR

    STATE --> DB["db.ts"]
    DB --> DBI["db-instance.ts"]
    STATE --> DBG["db-groups.ts"]
    IPC_T --> DBT["db-tasks.ts"]
    ML --> DBC["db-chats.ts"]

    INDEX --> WA["channels/whatsapp.ts"]
    INDEX --> TG["channels/telegram.ts"]
    WA --> WA_MSG["whatsapp-message.ts"]
    WA --> WA_SYNC["whatsapp-sync.ts"]
    TG --> TG_H["telegram-handlers.ts"]
    TG --> TG_F["telegram-formatters.ts"]
    TG --> TG_MO["telegram-model-override.ts"]

    GQ --> RP["retry-policy.ts"]
    INDEX --> GF["group-folder.ts"]
    INDEX --> CONF["config.ts"]
    INDEX --> LOG["logger.ts"]
    INDEX --> TYPES["types.ts"]

    classDef entry fill:#ff6b6b,stroke:#c92a2a,color:#fff
    classDef channel fill:#4a9eff,stroke:#2d7bd5,color:#fff
    classDef db fill:#f5a623,stroke:#d4891a,color:#fff
    classDef container fill:#7ed321,stroke:#5ea318,color:#fff
    classDef ipc fill:#bd10e0,stroke:#8e0ca8,color:#fff

    class INDEX entry
    class WA,TG,WA_MSG,WA_SYNC,TG_H,TG_F,TG_MO channel
    class DB,DBI,DBG,DBT,DBC db
    class CR,CM,CO,CRT,MS,MAL,MPU container
    class IPC,IPC_T,IPC_WR ipc
```
