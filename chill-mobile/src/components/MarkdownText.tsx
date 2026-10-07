/**
 * MarkdownText.tsx — assistant 正文的 Markdown 渲染层（呈现端职责，线路上永远跑原文）。
 *
 * 安全三纪律：原生 Text 渲染（无 WebView/HTML，构造上无注入面）；链接仅 http/https
 * （解析器 pattern 保证）+ Linking 打开；图片语法在解析层已降级为字面文本。
 * 样式哲学与 ChatScreen 一致：裸文本无气泡，装饰是例外的。
 */
import React, { useMemo } from 'react';
import { Linking, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { parseMarkdown, displayMarker, type Block, type Inline } from './markdown';

export function MarkdownText({ text, baseStyle, onLinkPress }: {
  text: string;
  baseStyle?: StyleProp<TextStyle>;
  /** 返回 true=已接管（不再 Linking.openURL）；缺省/返回 false=现行为。通用组件零业务知识 */
  onLinkPress?: (url: string) => boolean;
}) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <View style={styles.root}>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} baseStyle={baseStyle} onLinkPress={onLinkPress} />
      ))}
    </View>
  );
}

function BlockView({ block, baseStyle, onLinkPress }: { block: Block; baseStyle?: StyleProp<TextStyle>; onLinkPress?: (url: string) => boolean }) {
  const gapStyle = block.gap ? styles.blockGap : undefined; // 段落分隔（源文本空行）→ 段落级上边距
  switch (block.t) {
    case 'heading': {
      // 六档压三档：#/## 大一档，###/#### 中一档，#####+ 与正文同高仅加粗
      const st = block.level <= 2 ? styles.h1 : block.level <= 4 ? styles.h3 : styles.h5;
      return (
        <Text selectable style={[baseStyle, st, gapStyle]}>
          <InlineRuns onLinkPress={onLinkPress} nodes={block.c} />
        </Text>
      );
    }
    case 'hr':
      return <View style={[styles.hr, gapStyle]} />;
    case 'quote':
      return (
        <View style={[styles.quote, gapStyle]}>
          <Text selectable style={[baseStyle, styles.quoteText]}>
            <InlineRuns onLinkPress={onLinkPress} nodes={block.c} />
          </Text>
        </View>
      );
    case 'list':
      return (
        <Text selectable style={[baseStyle, styles.listItem, gapStyle, { paddingLeft: block.indent * 14 }]}>
          {displayMarker(block.marker)} <InlineRuns onLinkPress={onLinkPress} nodes={block.c} />
        </Text>
      );
    case 'code':
      return (
        <View style={[styles.codeBlock, gapStyle]}>
          <Text selectable style={styles.codeBlockText}>
            {block.s}
          </Text>
        </View>
      );
    case 'table':
      return (
        <View style={gapStyle}>
          <TableView header={block.header} rows={block.rows} baseStyle={baseStyle} onLinkPress={onLinkPress} />
        </View>
      );
    case 'para':
      return (
        <Text selectable style={[baseStyle, styles.para, gapStyle]}>
          <InlineRuns onLinkPress={onLinkPress} nodes={block.c} />
        </Text>
      );
  }
}

function TableView({ header, rows, baseStyle, onLinkPress }: { header: Inline[][]; rows: Inline[][][]; baseStyle?: StyleProp<TextStyle>; onLinkPress?: (url: string) => boolean }) {
  return (
    <View style={styles.table}>
      <View style={[styles.tableRow, styles.tableHeaderRow]}>
        {header.map((cell, i) => (
          <Text key={i} style={[styles.tableCell, baseStyle, styles.tableHeaderText]}>
            <InlineRuns onLinkPress={onLinkPress} nodes={cell} />
          </Text>
        ))}
      </View>
      {rows.map((row, r) => (
        <View key={r} style={styles.tableRow}>
          {row.map((cell, c) => (
            <Text key={c} style={[styles.tableCell, baseStyle]}>
              <InlineRuns onLinkPress={onLinkPress} nodes={cell} />
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

function InlineRuns({ nodes, onLinkPress }: { nodes: Inline[]; onLinkPress?: (url: string) => boolean }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'text':
            return <React.Fragment key={i}>{n.s}</React.Fragment>;
          case 'code':
            return (
              <Text key={i} style={styles.inlineCode}>
                {n.s}
              </Text>
            );
          case 'bold':
            return (
              <Text key={i} style={styles.bold}>
                <InlineRuns onLinkPress={onLinkPress} nodes={n.c} />
              </Text>
            );
          case 'italic':
            return (
              <Text key={i} style={styles.italic}>
                <InlineRuns onLinkPress={onLinkPress} nodes={n.c} />
              </Text>
            );
          case 'boldItalic':
            return (
              <Text key={i} style={[styles.bold, styles.italic]}>
                <InlineRuns onLinkPress={onLinkPress} nodes={n.c} />
              </Text>
            );
          case 'link':
            return (
              <Text
                key={i}
                style={styles.link}
                onPress={() => {
                  if (!onLinkPress?.(n.url)) void Linking.openURL(n.url);
                }}>
                <InlineRuns nodes={n.c} onLinkPress={onLinkPress} />
              </Text>
            );
        }
      })}
    </>
  );
}

const styles = StyleSheet.create({
  root: { marginVertical: 6 },
  para: { marginVertical: 1 }, // baseStyle 的 marginVertical 是给整条消息的，段落自身只留细缝
  blockGap: { marginTop: 13 }, // 段落分隔（源文本空行）：段落级上边距（约半行高，接近一个空行的视觉重量）
  h1: { fontSize: 17, fontWeight: '700', marginTop: 10, marginBottom: 2 },
  h3: { fontSize: 15.5, fontWeight: '700', marginTop: 8, marginBottom: 2 },
  h5: { fontWeight: '700', marginTop: 6 },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: '#374151', marginVertical: 10 },
  quote: { borderLeftWidth: 3, borderLeftColor: '#374151', paddingLeft: 10, marginVertical: 2 },
  quoteText: { color: '#9ca3af' },
  listItem: { marginVertical: 1 },
  codeBlock: {
    backgroundColor: '#111827',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginVertical: 6,
  },
  codeBlockText: { color: '#d1d5db', fontSize: 13, lineHeight: 19, fontFamily: 'monospace' },
  inlineCode: {
    backgroundColor: '#1f2937',
    color: '#e5e7eb',
    fontFamily: 'monospace',
    fontSize: 13.5,
  },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  link: { color: '#3b82f6', textDecorationLine: 'underline' },
  table: { marginVertical: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: '#374151', borderRadius: 6 },
  tableRow: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#1f2937' },
  tableHeaderRow: { borderTopWidth: 0, backgroundColor: '#111827' },
  tableHeaderText: { fontWeight: '700' },
  tableCell: { flex: 1, paddingHorizontal: 6, paddingVertical: 4, fontSize: 13, lineHeight: 18 },
});
