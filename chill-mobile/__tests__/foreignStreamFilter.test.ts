/**
 * 多会话并行显示修复（2026-10-05）纯逻辑回归：
 * - shouldDropForeignChatEvent：串台过滤——归属戳≠附着意图才丢（null 放行=旧桌面/未附着兼容）
 * - pickParkableBubbles：发送气泡停车场——只挑 dir='out'（流式卡/工具行/落定卡不停车）
 */
import { shouldDropForeignChatEvent } from '../src/relay/syncReducer';
import { pickParkableBubbles } from '../src/screens/syncUiLogic';
import type { ChatMessage } from '../src/relay/session';

const msg = (over: Partial<ChatMessage>): ChatMessage =>
  ({ id: 'x', dir: 'in', text: 't', kind: 'delta', ts: 0, ...over }) as ChatMessage;

describe('shouldDropForeignChatEvent（他会展流过滤）', () => {
  it('归属=附着 → 放行（正常流）', () => {
    expect(shouldDropForeignChatEvent('s-a', 's-a')).toBe(false);
  });
  it('归属≠附着 → 丢弃（attach 冲刷/FIFO 在途/429 积压窗口的他会帧）', () => {
    expect(shouldDropForeignChatEvent('s-a', 's-b')).toBe(true);
  });
  it('无戳（旧桌面）或未附着（无渲染面）→ 放行（加法兼容）', () => {
    expect(shouldDropForeignChatEvent(null, 's-a')).toBe(false);
    expect(shouldDropForeignChatEvent('s-a', null)).toBe(false);
    expect(shouldDropForeignChatEvent(null, null)).toBe(false);
  });
});

describe('pickParkableBubbles（发送气泡停车场挑选）', () => {
  it('只挑 dir=out 的气泡；流式卡/工具行/收件卡不停车', () => {
    const overlay = [
      msg({ id: 'env-1', dir: 'out', kind: 'chat.user' }),
      msg({ id: 'beat-env-1-0', dir: 'in', kind: 'delta' }),
      msg({ id: 'tool-tc-1', dir: 'in', kind: 'status' }),
      msg({ id: 'env-2', dir: 'out', kind: 'media' }),
      msg({ id: 'ask-1', dir: 'in', kind: 'ask' }),
    ];
    const picked = pickParkableBubbles(overlay);
    expect(picked.map((m) => m.id)).toEqual(['env-1', 'env-2']);
  });
  it('无可停车项 → 空集（parkOutBubbles 空集清键幂等）', () => {
    expect(pickParkableBubbles([msg({ id: 'a', dir: 'in' })])).toEqual([]);
    expect(pickParkableBubbles([])).toEqual([]);
  });
  it('不就地改写原数组', () => {
    const overlay = [msg({ id: 'env-1', dir: 'out' }), msg({ id: 'b', dir: 'in' })];
    const picked = pickParkableBubbles(overlay);
    expect(picked).not.toBe(overlay);
    expect(overlay.length).toBe(2);
  });
});
