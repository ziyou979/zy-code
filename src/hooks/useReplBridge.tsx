import { feature } from 'bun:bundle';
import React, { useCallback, useEffect, useRef } from 'react';
import { setMainLoopModelOverride } from '../bootstrap/state.js';
import { type BridgePermissionCallbacks, type BridgePermissionResponse, isBridgePermissionResponse } from '../bridge/bridgePermissionCallbacks.js';
import { buildBridgeConnectUrl } from '../bridge/bridgeStatusUtil.js';
import { extractInboundMessageFields } from '../bridge/inboundMessages.js';
import type { BridgeState, ReplBridgeHandle } from '../bridge/replBridge.js';
import { setReplBridgeHandle } from '../bridge/replBridgeHandle.js';
import type { Command } from '../commands.js';
import { getSlashCommandToolSkills, isBridgeSafeCommand } from '../commands.js';
import { getRemoteSessionUrl } from '../constants/product.js';
import { useNotifications } from '../context/notifications.js';
import type { PermissionMode, SDKMessage } from '../entrypoints/agentSdkTypes.js';
import type { SDKControlResponse } from '../entrypoints/sdk/controlTypes.js';
import { Text } from '../ink.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js';
import { useAppState, useAppStateStore, useSetAppState } from '../state/AppState.js';
import type { Message } from '../types/message.js';
import { getCwd } from '../utils/cwd.js';
import { logForDebugging } from '../utils/debug.js';
import { errorMessage } from '../utils/errors.js';
import { enqueue } from '../utils/messageQueueManager.js';
import { buildSystemInitMessage } from '../utils/messages/systemInit.js';
import { createBridgeStatusMessage, createSystemMessage } from '../utils/messages.js';
import { getAutoModeUnavailableNotification, getAutoModeUnavailableReason, isAutoModeGateEnabled, isBypassPermissionsModeDisabled, transitionPermissionMode } from '../utils/permissions/permissionSetup.js';
import { getLeaderToolUseConfirmQueue } from '../utils/swarm/leaderPermissionBridge.js';

/** 失败后多久自动清除 replBridgeEnabled（停止重试）。 */
export const BRIDGE_FAILURE_DISMISS_MS = 10_000;

/**
 * initReplBridge 连续失败的最大次数，超过此次数后 hook 将在整个 session
 * 生命周期内停止重试。用于防止在 OAuth 不可恢复的情况下，
 * replBridgeEnabled 被自动禁用后又通过其他路径（settings sync、
 * /remote-control、config tool）重新开启——每次重试都会产生一次
 * 对 POST /v1/environments/bridge 的 401 请求。Datadog 2026-03-08：
 * 最严重的卡死客户端每天产生 2,879 次 401（占该路由所有 401 的 17%）。
 */
const MAX_CONSECUTIVE_INIT_FAILURES = 3;

/**
 * Hook，在后台初始化一个始终在线的 bridge 连接，
 * 并将新的 user/assistant 消息写入 bridge session。
 *
 * 如果 bridge 未启用或用户未通过 OAuth 认证，则静默跳过。
 *
 * 监听 AppState.replBridgeEnabled——当关闭时（通过 /config 或 footer），
 * bridge 会被拆除。当重新开启时，它会重新初始化。
 *
 * 来自 zy.ai 的入站消息通过 queuedCommands 注入到 REPL 中。
 */
export function useReplBridge(messages: Message[], setMessages: (action: React.SetStateAction<Message[]>) => void, abortControllerRef: React.RefObject<AbortController | null>, commands: readonly Command[], mainLoopModel: string): {
  sendBridgeResult: () => void;
} {
  const handleRef = useRef<ReplBridgeHandle | null>(null);
  const teardownPromiseRef = useRef<Promise<void> | undefined>(undefined);
  const lastWrittenIndexRef = useRef(0);
  // 记录已作为初始消息刷新的 UUID。在 bridge 重连之间持久化，
  // 因此 Bridge #2+ 仅发送新消息——发送重复的 UUID 会导致服务器关闭 WebSocket。
  const flushedUUIDsRef = useRef(new Set<string>());
  const failureTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 在 effect 重跑之间持久化（与 effect 的局部状态不同）。
  // 仅在成功 init 时重置。达到 MAX_CONSECUTIVE_INIT_FAILURES 后保险丝熔断，
  // 无论 replBridgeEnabled 是否重新切换，整个 session 内不再重试。
  const consecutiveFailuresRef = useRef(0);
  const setAppState = useSetAppState();
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const mainLoopModelRef = useRef(mainLoopModel);
  mainLoopModelRef.current = mainLoopModel;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const store = useAppStateStore();
  const {
    addNotification
  } = useNotifications();
  const replBridgeEnabled = feature('BRIDGE_MODE') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useAppState(s => s.replBridgeEnabled) : false;
  const replBridgeConnected = feature('BRIDGE_MODE') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useAppState(s_0 => s_0.replBridgeConnected) : false;
  const replBridgeOutboundOnly = feature('BRIDGE_MODE') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useAppState(s_1 => s_1.replBridgeOutboundOnly) : false;
  const replBridgeInitialName = feature('BRIDGE_MODE') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useAppState(s_2 => s_2.replBridgeInitialName) : undefined;

  // 当启用状态变化时，初始化/拆除 bridge。
  // 传递当前消息作为 initialMessages，以便远程 session
  // 可以从现有对话上下文开始（例如来自 /bridge）。
  useEffect(() => {
    // feature() 检查必须使用正向模式以进行死代码消除——
    // 负向模式（if (!feature(...)) return）不会消除下方的动态 import。
    if (feature('BRIDGE_MODE')) {
      if (!replBridgeEnabled) return;
      const outboundOnly = replBridgeOutboundOnly;
      function notifyBridgeFailed(detail?: string): void {
        if (outboundOnly) return;
        addNotification({
          key: 'bridge-failed',
          jsx: <>
              <Text color="error">Remote Control failed</Text>
              {detail && <Text dimColor> · {detail}</Text>}
            </>,
          priority: 'immediate'
        });
      }
      if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_INIT_FAILURES) {
        logForDebugging(`[bridge:repl] Hook: ${consecutiveFailuresRef.current} consecutive init failures, not retrying this session`);
        // 清除 replBridgeEnabled，使 /remote-control 不会错误地
        // 为从未连接的 bridge 显示 BridgeDisconnectDialog。
        const fuseHint = 'disabled after repeated failures · restart to retry';
        notifyBridgeFailed(fuseHint);
        setAppState(prev => {
          if (prev.replBridgeError === fuseHint && !prev.replBridgeEnabled) return prev;
          return {
            ...prev,
            replBridgeError: fuseHint,
            replBridgeEnabled: false
          };
        });
        return;
      }
      let cancelled = false;
      // 现在捕获 messages.length，以便在 bridge 连接后
      // 不会通过 writeMessages 重新发送初始消息。
      const initialMessageCount = messages.length;
      void (async () => {
        try {
          // 在注册新 environment 之前，等待任何正在进行的 teardown 完成。
          // 否则，前一次 teardown 的 deregister HTTP 调用会与
          // 新的 register 调用发生竞争，服务器可能会拆除刚创建的 environment。
          if (teardownPromiseRef.current) {
            logForDebugging('[bridge:repl] Hook: waiting for previous teardown to complete before re-init');
            await teardownPromiseRef.current;
            teardownPromiseRef.current = undefined;
            logForDebugging('[bridge:repl] Hook: previous teardown complete, proceeding with re-init');
          }
          if (cancelled) return;

          // 动态 import，使该模块在 external 构建 中被 tree-shake 掉
          const {
            initReplBridge
          } = await import('../bridge/initReplBridge.js');
          const {
            shouldShowAppUpgradeMessage
          } = await import('../bridge/envLessBridgeConfig.js');

          // Assistant 模式：永久 bridge session——zy.ai 在 CLI 重启之间
          // 显示一个连续的对话，而不是每次调用创建新 session。
          // initBridgeCore 读取 bridge-pointer.json（#20735 添加的
          // 崩溃恢复文件），并通过 reuseEnvironmentId + api.reconnectSession()
          // 重用其 {environmentId, sessionId}。Teardown 跳过
          // archive/deregister/pointer-clear，因此 session 能在正常退出
          // 而不仅仅是崩溃后存活。非 assistant bridge 在 teardown 时清除
          // pointer（仅用于崩溃恢复）。
          let perpetual = false;
          if (feature('KAIROS')) {
            const {
              isAssistantMode
            } = await import('../assistant/index.js' as any);
            // @ts-ignore
            perpetual = (isAssistantMode as any)();
          }

          // 当来自 zy.ai 的用户消息到达时，将其注入到 REPL 中。
          // 保留原始 UUID，以便消息转发回 CCR 时与原始消息匹配——避免重复消息。
          //
          // 异步是因为 file_attachments（如果存在）需要在入队 @path 前缀之前
          // 进行网络获取 + 磁盘写入。调用者不会 await——带附件的消息只是
          // 稍晚一些进入队列，这没问题（web 消息不是快速连发的）。
          async function handleInboundMessage(msg: SDKMessage): Promise<void> {
            try {
              const fields = extractInboundMessageFields(msg);
              if (!fields) return;
              const {
                uuid
              } = fields;

              // 动态 import，使 bridge 代码不会出现在非 BRIDGE_MODE 构建中。
              const {
                resolveAndPrepend
              } = await import('../bridge/inboundAttachments.js');
              let sanitized = fields.content;
              if (feature('KAIROS_GITHUB_WEBHOOKS')) {
                /* eslint-disable @typescript-eslint/no-require-imports */
                const webhookModule = require('../bridge/webhookSanitizer.js' as any);
                /* eslint-enable @typescript-eslint/no-require-imports */
                sanitized = (webhookModule as any).sanitizeInboundWebhookContent(fields.content) as any;
              }
              const content = await resolveAndPrepend(msg, sanitized);
              const preview = typeof content === 'string' ? content.slice(0, 80) : `[${content.length} content blocks]`;
              logForDebugging(`[bridge:repl] Injecting inbound user message: ${preview}${uuid ? ` uuid=${uuid}` : ''}`);
              enqueue({
                value: content,
                mode: 'prompt' as const,
                uuid,
                // skipSlashCommands 保持 true 作为纵深防御——
                // 当 bridgeOrigin 已设置且解析后的命令通过 isBridgeSafeCommand 时，
                // processUserInputBase 会在内部覆盖它。
                // 这使退出词抑制和即时命令块保持完整，适用于任何
                // 直接检查 skipSlashCommands 的代码路径。
                skipSlashCommands: true,
                bridgeOrigin: true
              });
            } catch (e) {
              logForDebugging(`[bridge:repl] handleInboundMessage failed: ${e}`, {
                level: 'error'
              });
            }
          }

          // 状态变更回调——将 bridge 生命周期事件映射到 AppState。
          function handleStateChange(state: BridgeState, detail_0?: string): void {
            if (cancelled) return;
            if (outboundOnly) {
              logForDebugging(`[bridge:repl] Mirror state=${state}${detail_0 ? ` detail=${detail_0}` : ''}`);
              // 同步 replBridgeConnected，使转发 effect 在传输层建立或断开时开始/停止写入。
              if (state === 'failed') {
                setAppState(prev_3 => {
                  if (!prev_3.replBridgeConnected) return prev_3;
                  return {
                    ...prev_3,
                    replBridgeConnected: false
                  };
                });
              } else if (state === 'ready' || state === 'connected') {
                setAppState(prev_4 => {
                  if (prev_4.replBridgeConnected) return prev_4;
                  return {
                    ...prev_4,
                    replBridgeConnected: true
                  };
                });
              }
              return;
            }
            const handle = handleRef.current;
            switch (state) {
              case 'ready':
                setAppState(prev_9 => {
                  const connectUrl = handle && handle.environmentId !== '' ? buildBridgeConnectUrl(handle.environmentId, handle.sessionIngressUrl) : prev_9.replBridgeConnectUrl;
                  const sessionUrl = handle ? getRemoteSessionUrl(handle.bridgeSessionId, handle.sessionIngressUrl) : prev_9.replBridgeSessionUrl;
                  const envId = handle?.environmentId;
                  const sessionId = handle?.bridgeSessionId;
                  if (prev_9.replBridgeConnected && !prev_9.replBridgeSessionActive && !prev_9.replBridgeReconnecting && prev_9.replBridgeConnectUrl === connectUrl && prev_9.replBridgeSessionUrl === sessionUrl && prev_9.replBridgeEnvironmentId === envId && prev_9.replBridgeSessionId === sessionId) {
                    return prev_9;
                  }
                  return {
                    ...prev_9,
                    replBridgeConnected: true,
                    replBridgeSessionActive: false,
                    replBridgeReconnecting: false,
                    replBridgeConnectUrl: connectUrl,
                    replBridgeSessionUrl: sessionUrl,
                    replBridgeEnvironmentId: envId,
                    replBridgeSessionId: sessionId,
                    replBridgeError: undefined
                  };
                });
                break;
              case 'connected':
                {
                  setAppState(prev_8 => {
                    if (prev_8.replBridgeSessionActive) return prev_8;
                    return {
                      ...prev_8,
                      replBridgeConnected: true,
                      replBridgeSessionActive: true,
                      replBridgeReconnecting: false,
                      replBridgeError: undefined
                    };
                  });
                  // 发送 system/init 使远程客户端（web/iOS/Android）获取 session 元数据。
                  // REPL 直接使用 query()——从不经过 QueryEngine 的 SDKMessage 层——
                  // 因此这是将 system/init 放到 REPL-bridge 线上的唯一路径。
                  // Skills 加载是异步的（memoized，REPL 启动后开销小）；
                  // fire-and-forget 以免阻塞连接状态转换。
                  if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_bridge_system_init', false)) {
                    void (async () => {
                      try {
                        const skills = await getSlashCommandToolSkills(getCwd());
                        if (cancelled) return;
                        const state_0 = store.getState();
                        handleRef.current?.writeSdkMessages([buildSystemInitMessage({
                          // tools/mcpClients/plugins 对 REPL-bridge 进行了脱敏：
                          // MCP 前缀的工具名和服务器名会泄露用户已接入的集成；
                          // 插件路径会泄露原始文件系统路径（用户名、项目结构）。
                          // CCR v2 将 SDK 消息持久化到 Spanner——点击"从手机连接"的
                          // 用户可能不希望这些信息出现在 Anthropic 的服务器上。
                          // QueryEngine（SDK）仍然发出完整列表——SDK 消费者期望完整遥测。
                          tools: [],
                          mcpClients: [],
                          model: mainLoopModelRef.current,
                          permissionMode: state_0.toolPermissionContext.mode as PermissionMode,
                          // TODO: 避免此类型转换
                          // 远程客户端只能调用 bridge-safe 命令——
                          // 广告不安全的命令（local-jsx、未允许的 local）
                          // 会让 mobile/web 尝试调用并遇到错误。
                          commands: commandsRef.current.filter(isBridgeSafeCommand),
                          agents: state_0.agentDefinitions.activeAgents,
                          skills,
                          plugins: [],
                          fastMode: state_0.fastMode
                        })]);
                      } catch (err_0) {
                        logForDebugging(`[bridge:repl] Failed to send system/init: ${errorMessage(err_0)}`, {
                          level: 'error'
                        });
                      }
                    })();
                  }
                  break;
                }
              case 'reconnecting':
                setAppState(prev_7 => {
                  if (prev_7.replBridgeReconnecting) return prev_7;
                  return {
                    ...prev_7,
                    replBridgeReconnecting: true,
                    replBridgeSessionActive: false
                  };
                });
                break;
              case 'failed':
                // 清除上一次的失败dismiss计时器
                clearTimeout(failureTimeoutRef.current);
                notifyBridgeFailed(detail_0);
                setAppState(prev_5 => ({
                  ...prev_5,
                  replBridgeError: detail_0,
                  replBridgeReconnecting: false,
                  replBridgeSessionActive: false,
                  replBridgeConnected: false
                }));
                // 超时后自动禁用，使 hook 停止重试。
                failureTimeoutRef.current = setTimeout(() => {
                  if (cancelled) return;
                  failureTimeoutRef.current = undefined;
                  setAppState(prev_6 => {
                    if (!prev_6.replBridgeError) return prev_6;
                    return {
                      ...prev_6,
                      replBridgeEnabled: false,
                      replBridgeError: undefined
                    };
                  });
                }, BRIDGE_FAILURE_DISMISS_MS);
                break;
            }
          }

          // 等待中的 bridge 权限响应 handler 映射，以 request_id 为键。
          // 每个条目是一个等待 CCR 回复的 onResponse handler。
          const pendingPermissionHandlers = new Map<string, (response: BridgePermissionResponse) => void>();

          // 将收到的 control_response 消息分发给已注册的 handler
          function handlePermissionResponse(msg_0: SDKControlResponse): void {
            const requestId = msg_0.response?.request_id;
            if (!requestId) return;
            const handler = pendingPermissionHandlers.get(requestId);
            if (!handler) {
              logForDebugging(`[bridge:repl] No handler for control_response request_id=${requestId}`);
              return;
            }
            pendingPermissionHandlers.delete(requestId);
            // 从 control_response 负载中提取权限决策
            const inner = msg_0.response;
            if (inner.subtype === 'success' && inner.response && isBridgePermissionResponse(inner.response)) {
              handler(inner.response);
            }
          }
          const handle_0 = await initReplBridge({
            outboundOnly,
            tags: outboundOnly ? ['ccr-mirror'] : undefined,
            onInboundMessage: handleInboundMessage,
            onPermissionResponse: handlePermissionResponse,
            onInterrupt() {
              abortControllerRef.current?.abort();
            },
            onSetModel(model) {
              const resolved = model === 'default' ? null : model ?? null;
              setMainLoopModelOverride(resolved);
              setAppState(prev_10 => {
                if (prev_10.mainLoopModelForSession === resolved) return prev_10;
                return {
                  ...prev_10,
                  mainLoopModelForSession: resolved
                };
              });
            },
            onSetMaxThinkingTokens(maxTokens) {
              const enabled = maxTokens !== null;
              setAppState(prev_11 => {
                if (prev_11.thinkingEnabled === enabled) return prev_11;
                return {
                  ...prev_11,
                  thinkingEnabled: enabled
                };
              });
            },
            onSetPermissionMode(mode) {
              // 策略守卫必须在 transitionPermissionMode 之前触发——
              // 其内部的 auto-gate 检查是防御性抛出（在抛出之前有
              // setAutoModeActivity(true) 副作用），而不是优雅拒绝。
              // 让该抛出逃逸会：
              // (1) 在 mode 不变的情况下留下 STATE.autoModeActive=true
              //     （违反 src/CLAUDE.md 中的三方不变式）
              // (2) 无法发送 control_response → 服务器关闭 WS
              // 这些镜像于 print.ts handleSetPermissionMode；bridge
              // 无法直接导入这些检查（bootstrap-isolation），因此
              // 依赖此判定来发出错误响应。
              if (mode === 'bypassPermissions') {
                if (isBypassPermissionsModeDisabled()) {
                  return {
                    ok: false,
                    error: 'Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration'
                  };
                }
                if (!store.getState().toolPermissionContext.isBypassPermissionsModeAvailable) {
                  return {
                    ok: false,
                    error: 'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions'
                  };
                }
              }
              if (feature('TRANSCRIPT_CLASSIFIER') && mode === 'auto' && !isAutoModeGateEnabled()) {
                const reason = getAutoModeUnavailableReason();
                return {
                  ok: false,
                  error: reason ? `Cannot set permission mode to auto: ${getAutoModeUnavailableNotification(reason)}` : 'Cannot set permission mode to auto'
                };
              }
              // 守卫通过——通过集中式 transition 应用，
              // 使 prePlanMode 存储和 auto-mode 状态同步全部触发。
              setAppState(prev_12 => {
                const current = prev_12.toolPermissionContext.mode;
                if (current === mode) return prev_12;
                const next = transitionPermissionMode(current, mode, prev_12.toolPermissionContext);
                return {
                  ...prev_12,
                  toolPermissionContext: {
                    ...next,
                    mode
                  }
                };
              });
              // 模式已变更，重新检查队列中的权限提示。
              setImmediate(() => {
                getLeaderToolUseConfirmQueue()?.(currentQueue => {
                  currentQueue.forEach(item => {
                    void item.recheckPermission();
                  });
                  return currentQueue;
                });
              });
              return {
                ok: true
              };
            },
            onStateChange: handleStateChange,
            initialMessages: messages.length > 0 ? messages : undefined,
            getMessages: () => messagesRef.current,
            previouslyFlushedUUIDs: flushedUUIDsRef.current,
            initialName: replBridgeInitialName,
            perpetual
          });
          if (cancelled) {
            // Effect 在 initReplBridge 执行期间被取消。
            // 拆除 handle 以避免泄漏资源（poll loop、
            // WebSocket、已注册的 environment、清理回调）。
            logForDebugging(`[bridge:repl] Hook: init cancelled during flight, tearing down${handle_0 ? ` env=${handle_0.environmentId}` : ''}`);
            if (handle_0) {
              void handle_0.teardown();
            }
            return;
          }
          if (!handle_0) {
            // initReplBridge 返回 null——前置条件失败。对于大多数情况
            // （no_oauth、policy_denied 等），onStateChange('failed')
            // 已带着具体提示触发。GrowthBook-gate-off 的情况是故意静默的——
            // 不是失败，只是尚未推送。
            consecutiveFailuresRef.current++;
            logForDebugging(`[bridge:repl] Init returned null (precondition or session creation failed); consecutive failures: ${consecutiveFailuresRef.current}`);
            clearTimeout(failureTimeoutRef.current);
            setAppState(prev_13 => ({
              ...prev_13,
              replBridgeError: prev_13.replBridgeError ?? 'check debug logs for details'
            }));
            failureTimeoutRef.current = setTimeout(() => {
              if (cancelled) return;
              failureTimeoutRef.current = undefined;
              setAppState(prev_14 => {
                if (!prev_14.replBridgeError) return prev_14;
                return {
                  ...prev_14,
                  replBridgeEnabled: false,
                  replBridgeError: undefined
                };
              });
            }, BRIDGE_FAILURE_DISMISS_MS);
            return;
          }
          handleRef.current = handle_0;
          setReplBridgeHandle(handle_0);
          consecutiveFailuresRef.current = 0;
          // 在转发 effect 中跳过初始消息——它们已在创建时
          // 作为 session events 加载。
          lastWrittenIndexRef.current = initialMessageCount;
          if (outboundOnly) {
            setAppState(prev_15 => {
              if (prev_15.replBridgeConnected && prev_15.replBridgeSessionId === handle_0.bridgeSessionId) return prev_15;
              return {
                ...prev_15,
                replBridgeConnected: true,
                replBridgeSessionId: handle_0.bridgeSessionId,
                replBridgeSessionUrl: undefined,
                replBridgeConnectUrl: undefined,
                replBridgeError: undefined
              };
            });
            logForDebugging(`[bridge:repl] Mirror initialized, session=${handle_0.bridgeSessionId}`);
          } else {
            // 构建 bridge 权限回调，使交互式权限 handler
            // 可以在 bridge 响应和本地用户交互之间进行竞态。
            const permissionCallbacks: BridgePermissionCallbacks = {
              sendRequest(requestId_0, toolName, input, toolUseId, description, permissionSuggestions, blockedPath) {
                handle_0.sendControlRequest({
                  type: 'control_request',
                  request_id: requestId_0,
                  request: {
                    subtype: 'can_use_tool',
                    tool_name: toolName,
                    input,
                    tool_use_id: toolUseId,
                    description,
                    ...(permissionSuggestions ? {
                      permission_suggestions: permissionSuggestions
                    } : {}),
                    ...(blockedPath ? {
                      blocked_path: blockedPath
                    } : {})
                  }
                });
              },
              sendResponse(requestId_1, response) {
                const payload: Record<string, unknown> = {
                  ...response
                };
                handle_0.sendControlResponse({
                  type: 'control_response',
                  response: {
                    subtype: 'success',
                    request_id: requestId_1,
                    response: payload
                  }
                });
              },
              cancelRequest(requestId_2) {
                handle_0.sendControlCancelRequest(requestId_2);
              },
              onResponse(requestId_3, handler_0) {
                pendingPermissionHandlers.set(requestId_3, handler_0);
                return () => {
                  pendingPermissionHandlers.delete(requestId_3);
                };
              }
            };
            setAppState(prev_16 => ({
              ...prev_16,
              replBridgePermissionCallbacks: permissionCallbacks
            }));
            const url = getRemoteSessionUrl(handle_0.bridgeSessionId, handle_0.sessionIngressUrl);
            // environmentId === '' 表示 v2 无 env 路径。buildBridgeConnectUrl
            // 构建特定于 env 的连接 URL，没有 env 时不存在。
            const hasEnv = handle_0.environmentId !== '';
            const connectUrl_0 = hasEnv ? buildBridgeConnectUrl(handle_0.environmentId, handle_0.sessionIngressUrl) : undefined;
            setAppState(prev_17 => {
              if (prev_17.replBridgeConnected && prev_17.replBridgeSessionUrl === url) {
                return prev_17;
              }
              return {
                ...prev_17,
                replBridgeConnected: true,
                replBridgeSessionUrl: url,
                replBridgeConnectUrl: connectUrl_0 ?? prev_17.replBridgeConnectUrl,
                replBridgeEnvironmentId: handle_0.environmentId,
                replBridgeSessionId: handle_0.bridgeSessionId,
                replBridgeError: undefined
              };
            });

            // 在转录中显示 bridge 状态及 URL。perpetual（KAIROS
            // assistant 模式）在 initReplBridge.ts 回退到 v1——
            // 为他们跳过仅 v2 的升级提示。使用独立的 try/catch，
            // 使 GrowthBook 的小问题不会影响到外层的 init-failure handler。
            const upgradeNudge = !perpetual ? await shouldShowAppUpgradeMessage().catch(() => false) : false;
            if (cancelled) return;
            setMessages(prev_18 => [...prev_18, createBridgeStatusMessage(url, upgradeNudge ? 'Please upgrade to the latest version of the Zy mobile app to see your Remote Control sessions.' : undefined)]);
            logForDebugging(`[bridge:repl] Hook initialized, session=${handle_0.bridgeSessionId}`);
          }
        } catch (err) {
          // 绝不让 REPL 崩溃——在 UI 中暴露错误。
          // 先检查 cancelled（与 ~386 行 !handle 路径对称）：
          // 如果 initReplBridge 在快速 toggle-off 期间抛出（进行中的网络错误），
          // 不要将其计入保险丝或向 UI 发送过时的错误。
          // 同时修复了之前在 cancelled 抛出时虚假的 setAppState/setMessages。
          if (cancelled) return;
          consecutiveFailuresRef.current++;
          const errMsg = errorMessage(err);
          logForDebugging(`[bridge:repl] Init failed: ${errMsg}; consecutive failures: ${consecutiveFailuresRef.current}`);
          clearTimeout(failureTimeoutRef.current);
          notifyBridgeFailed(errMsg);
          setAppState(prev_0 => ({
            ...prev_0,
            replBridgeError: errMsg
          }));
          failureTimeoutRef.current = setTimeout(() => {
            if (cancelled) return;
            failureTimeoutRef.current = undefined;
            setAppState(prev_1 => {
              if (!prev_1.replBridgeError) return prev_1;
              return {
                ...prev_1,
                replBridgeEnabled: false,
                replBridgeError: undefined
              };
            });
          }, BRIDGE_FAILURE_DISMISS_MS);
          if (!outboundOnly) {
            // @ts-ignore
            setMessages(prev_2 => [...prev_2, createSystemMessage(`Remote Control failed to connect: ${errMsg}`, 'warning')]);
          }
        }
      })();
      return () => {
        cancelled = true;
        clearTimeout(failureTimeoutRef.current);
        failureTimeoutRef.current = undefined;
        if (handleRef.current) {
          logForDebugging(`[bridge:repl] Hook cleanup: starting teardown for env=${handleRef.current.environmentId} session=${handleRef.current.bridgeSessionId}`);
          teardownPromiseRef.current = handleRef.current.teardown();
          handleRef.current = null;
          setReplBridgeHandle(null);
        }
        setAppState(prev_19 => {
          if (!prev_19.replBridgeConnected && !prev_19.replBridgeSessionActive && !prev_19.replBridgeError) {
            return prev_19;
          }
          return {
            ...prev_19,
            replBridgeConnected: false,
            replBridgeSessionActive: false,
            replBridgeReconnecting: false,
            replBridgeConnectUrl: undefined,
            replBridgeSessionUrl: undefined,
            replBridgeEnvironmentId: undefined,
            replBridgeSessionId: undefined,
            replBridgeError: undefined,
            replBridgePermissionCallbacks: undefined
          };
        });
        lastWrittenIndexRef.current = 0;
      };
    }
  }, [replBridgeEnabled, replBridgeOutboundOnly, setAppState, setMessages, addNotification]);

  // 新消息出现时写入。
  // 当 replBridgeConnected 变化时（bridge 完成初始化）也会重跑，
  // 因此 bridge 就绪之前到达的消息也会被写入。
  useEffect(() => {
    // 正向 feature() 守卫——参见第一个 useEffect 注释
    if (feature('BRIDGE_MODE')) {
      if (!replBridgeConnected) return;
      const handle_1 = handleRef.current;
      if (!handle_1) return;

      // 如果消息被压缩（数组缩短），钳位索引。
      // 压缩后 ref 可能超过 messages.length，如果不钳位则不会转发新消息。
      if (lastWrittenIndexRef.current > messages.length) {
        logForDebugging(`[bridge:repl] Compaction detected: lastWrittenIndex=${lastWrittenIndexRef.current} > messages.length=${messages.length}, clamping`);
      }
      const startIndex = Math.min(lastWrittenIndexRef.current, messages.length);

      // 收集上次写入以来的新消息
      const newMessages: Message[] = [];
      for (let i = startIndex; i < messages.length; i++) {
        const msg_1 = messages[i];
        if (msg_1 && (msg_1.type === 'user' || msg_1.type === 'assistant' || msg_1.type === 'system' && msg_1.subtype === 'local_command')) {
          newMessages.push(msg_1);
        }
      }
      lastWrittenIndexRef.current = messages.length;
      if (newMessages.length > 0) {
        handle_1.writeMessages(newMessages);
      }
    }
  }, [messages, replBridgeConnected]);
  const sendBridgeResult = useCallback(() => {
    if (feature('BRIDGE_MODE')) {
      handleRef.current?.sendResult();
    }
  }, []);
  return {
    sendBridgeResult
  };
}
