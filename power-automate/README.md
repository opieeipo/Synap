# Power Automate Connector for Synap

This directory contains the flow definitions for running Synap's backend via Power Automate instead of Azure Functions. Use this when Azure Functions are not available in your corporate environment.

## Overview

Three HTTP-triggered flows replicate the Azure Functions:

1. **Synap-Session-Start** — Creates a session on consent acceptance
2. **Synap-Chat** — Handles each interview turn (AI call + theme coding + storage)
3. **Synap-Session-End** — Marks a session complete

## Setup

### Prerequisites

- Power Automate Premium license (required for HTTP triggers and custom connectors)
- An HTTP connector or Azure API Management endpoint to expose the flows
- Storage: SharePoint Lists (most natural for Power Automate) or a custom connector to Cosmos DB/Azure SQL

### Import the Flows

1. Go to [Power Automate](https://make.powerautomate.com)
2. Click **My Flows** > **Import** > **Import Package**
3. Import each `.zip` flow package from this directory
4. Configure the connections:
   - SharePoint connection for storage
   - HTTP connector for AI provider calls

### Flow Definitions

Each flow follows this pattern:

```
HTTP Request Trigger (POST)
  → Parse JSON (request body)
  → Initialize variables (session state)
  → Storage operations (SharePoint / Dataverse)
  → HTTP action (AI provider API call)
  → HTTP action (theme coding API call)
  → Storage operations (save response + themes)
  → HTTP Response (reply to frontend)
```

### Session-Start Flow

**Trigger:** HTTP POST

**Input:**
```json
{ "session_id": "...", "interview_config": { ... } }
```

**Actions:**
1. Create item in SynapSessions SharePoint list
2. Create item in SynapEvents list (consent_accepted)
3. Create item in SynapMessages list (AI greeting)
4. Return greeting to frontend

### Chat Flow

**Trigger:** HTTP POST

**Input:**
```json
{ "session_id": "...", "message": "..." }
```

**Actions:**
1. Get session from SynapSessions list
2. Get message history from SynapMessages list
3. Build system prompt (using a Compose action with the prompt template)
4. HTTP POST to AI provider (Claude/OpenAI/Azure OpenAI/Gemini)
5. Parse AI response
6. HTTP POST to AI provider for theme coding (parallel branch)
7. Create items in SynapMessages (user message + AI response)
8. Create items in SynapThemes (detected themes)
9. Update SynapSessions turn count
10. Return response to frontend

### Session-End Flow

**Trigger:** HTTP POST

**Input:**
```json
{ "session_id": "...", "reason": "..." }
```

**Actions:**
1. Update SynapSessions status to "completed"
2. Create item in SynapEvents (interview_ended)
3. Return confirmation

## AI Provider HTTP Actions

### Claude (Anthropic)

```
Method: POST
URI: https://api.anthropic.com/v1/messages
Headers:
  x-api-key: @{variables('ANTHROPIC_API_KEY')}
  anthropic-version: 2023-06-01
  Content-Type: application/json
Body:
  {
    "model": "@{variables('ai_model')}",
    "max_tokens": 1024,
    "system": "@{variables('system_prompt')}",
    "messages": @{variables('conversation_history')}
  }
```

### OpenAI

```
Method: POST
URI: https://api.openai.com/v1/chat/completions
Headers:
  Authorization: Bearer @{variables('OPENAI_API_KEY')}
  Content-Type: application/json
Body:
  {
    "model": "@{variables('ai_model')}",
    "messages": @{variables('messages_with_system')}
  }
```

### Azure OpenAI

```
Method: POST
URI: @{variables('AZURE_ENDPOINT')}/openai/deployments/@{variables('deployment')}/chat/completions?api-version=2024-06-01
Headers:
  api-key: @{variables('AZURE_OPENAI_API_KEY')}
  Content-Type: application/json
Body:
  {
    "messages": @{variables('messages_with_system')}
  }
```

### Gemini

```
Method: POST
URI: https://generativelanguage.googleapis.com/v1beta/models/@{variables('ai_model')}:generateContent?key=@{variables('GEMINI_API_KEY')}
Headers:
  Content-Type: application/json
Body:
  {
    "systemInstruction": { "parts": [{ "text": "@{variables('system_prompt')}" }] },
    "contents": @{variables('gemini_contents')}
  }
```

## Limitations vs Azure Functions

- **Slower** — Power Automate flows have higher latency per execution (~2-5s overhead)
- **Rate limits** — Flow runs are throttled based on your license tier
- **Complex logic** — Building the system prompt and parsing theme JSON requires more Compose/Parse actions
- **No shared code** — Each flow duplicates the prompt-building logic since Power Automate doesn't support shared modules

## Frontend Configuration

Point the frontend to your flow URLs:

```json
"settings": {
  "ai_provider": "claude",
  "endpoint": "https://prod-XX.westus.logic.azure.com:443/workflows/..."
}
```

When `endpoint` is set in the config, the frontend uses it directly instead of constructing Supabase/Azure Function URLs.
