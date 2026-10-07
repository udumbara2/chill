/**
 * IdeaCaptureSheet.tsx — 记个点子面板（闪念捕获 · 唯一面板组件，R2）
 *
 * AgentList 首屏 💡 与 ChatScreen（＋ 菜单首行 / 长按 ＋ 直达 / ☰ 维护节行）共用本组件。
 * 通道：cmd.request('idea')——确定性命令面（不劫持对话、不占模型轮）；
 * 语音输入 = 系统键盘听写（不自研 ASR）；提交回执由 App 根级 cmdResult 订阅统一呈现（R3）。
 *
 * 键盘遮挡修复（v3 · 确定性方案）：v2 的键盘高度垫高在 Modal（Android 独立窗口）内实测无效——
 * keyboard-controller 的插焦监听挂主窗口，Modal 内 kbHeight 恒 0。根治 = 布局上与键盘物理错开：
 * 面板从**顶部**滑下（top ~10%），输入法再大也只占下半屏，不依赖任何键盘事件。
 * 动画方向同步翻转（从上方滑入/收起），卡片四角圆角（不再是底部 sheet 的上圆角）。
 */
import React, { useEffect, useRef } from 'react';
import { Modal, Pressable, Text, TextInput, View, Animated, Easing, StyleSheet } from 'react-native';

type TextInputLike = { focus: () => void; blur?: () => void };

export default function IdeaCaptureSheet(props: {
  visible: boolean;
  onClose: () => void;
  /** 提交（调用方负责 sendCmdRequest；返回错误文案则面板内联提示，否则收起） */
  onSubmit: (text: string) => Promise<string | null>;
}) {
  const [text, setText] = React.useState('');
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const slide = useRef(new Animated.Value(0)).current;
  // RN 0.87 的 TextInput 导出类型不含实例方法（focus）——按需最小鸭子类型
  const inputRef = useRef<TextInputLike>(null);

  useEffect(() => {
    if (props.visible) {
      setText('');
      setErr(null);
      setBusy(false);
      slide.setValue(0);
      Animated.timing(slide, { toValue: 1, duration: 300, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
      // 自动聚焦弹键盘（听写一步可达：点键盘麦克风即可说）；面板在顶部，键盘不可能盖住
      setTimeout(() => inputRef.current?.focus(), 360);
    }
  }, [props.visible, slide]);

  const close = () => {
    inputRef.current?.blur?.();
    Animated.timing(slide, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => props.onClose());
  };

  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setErr(null);
    const e = await props.onSubmit(t);
    setBusy(false);
    if (e) {
      setErr(e);
      return;
    }
    close();
  };

  return (
    <Modal visible={props.visible} transparent animationType="none" onRequestClose={close}>
      <Pressable style={styles.scrim} onPress={close} />
      {/* 顶部卡片：与键盘物理错开（键盘只占下半屏）——确定性布局，零键盘事件依赖 */}
      <Animated.View
        style={[
          styles.card,
          {
            opacity: slide,
            transform: [
              {
                translateY: slide.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-120, 0],
                }),
              },
            ],
          },
        ]}
      >
        <TextInput
          ref={inputRef as unknown as React.Ref<React.ComponentRef<typeof TextInput>>}
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="💡 想到什么，说一句…"
          placeholderTextColor="#9ca3af"
          multiline={false}
          autoFocus={false}
          onSubmitEditing={() => void submit()}
          returnKeyType="done"
        />
        {err ? <Text style={styles.err}>{err}</Text> : null}
        <View style={styles.acts}>
          <Pressable style={[styles.btn, !text.trim() && styles.btnDim]} onPress={() => void submit()} hitSlop={6}>
            <Text style={styles.btnText}>{busy ? '提交中…' : '记下'}</Text>
          </Pressable>
        </View>
      </Animated.View>
    </Modal>
  );
}

const BG = '#ffffff';
const LINE = '#f3f4f6';

const styles = StyleSheet.create({
  scrim: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
  card: {
    position: 'absolute',
    left: 20,
    right: 20,
    top: '12%',
    backgroundColor: BG,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  input: {
    borderWidth: 0,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    fontSize: 16,
    color: '#111827',
    backgroundColor: '#fff',
  },
  err: { color: '#b45309', fontSize: 12, marginTop: 4 },
  acts: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 6 },
  btn: { backgroundColor: '#3b82f6', borderRadius: 9, paddingVertical: 7, paddingHorizontal: 22 },
  btnText: { fontSize: 13.5, color: '#fff', fontWeight: '600' },
  btnDim: { opacity: 0.4 },
});
