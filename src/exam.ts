import type { ExamQuestion } from './types.js';

/** 固定考核：10 道等权题目（6 单选 + 4 多选），答对 70%（7 题）即通过。 */
export const FIXED_EXAM: ExamQuestion[] = [
  {
    id: 'q1',
    kind: 'single',
    prompt: 'TypeScript 中用于声明只读属性的修饰符是？',
    options: [
      { id: 'a', text: 'const' },
      { id: 'b', text: 'readonly' },
      { id: 'c', text: 'final' },
      { id: 'd', text: 'static' },
    ],
    correct: ['b'],
  },
  {
    id: 'q2',
    kind: 'single',
    prompt: 'SQLite 中保证单条 INSERT 原子性的机制是？',
    options: [
      { id: 'a', text: '事务日志（journal/WAL）' },
      { id: 'b', text: '内存缓存' },
      { id: 'c', text: '触发器' },
      { id: 'd', text: '视图' },
    ],
    correct: ['a'],
  },
  {
    id: 'q3',
    kind: 'single',
    prompt: '60 分钟等于多少毫秒？',
    options: [
      { id: 'a', text: '360000' },
      { id: 'b', text: '3600000' },
      { id: 'c', text: '60000' },
      { id: 'd', text: '86400000' },
    ],
    correct: ['b'],
  },
  {
    id: 'q4',
    kind: 'single',
    prompt: '幂等操作的核心特征是？',
    options: [
      { id: 'a', text: '执行速度极快' },
      { id: 'b', text: '同一请求重复执行的效果与执行一次相同' },
      { id: 'c', text: '必须使用缓存' },
      { id: 'd', text: '永远不会失败' },
    ],
    correct: ['b'],
  },
  {
    id: 'q5',
    kind: 'single',
    prompt: '以下哪种方式能让文件写入对崩溃更安全？',
    options: [
      { id: 'a', text: '先写临时文件再原子重命名' },
      { id: 'b', text: '直接原地覆盖' },
      { id: 'c', text: '增大缓冲区' },
      { id: 'd', text: '使用更短的文件名' },
    ],
    correct: ['a'],
  },
  {
    id: 'q6',
    kind: 'single',
    prompt: 'Node.js 内置的 SQLite 模块名是？',
    options: [
      { id: 'a', text: 'node:sql' },
      { id: 'b', text: 'node:sqlite' },
      { id: 'c', text: 'node:db' },
      { id: 'd', text: 'node:database' },
    ],
    correct: ['b'],
  },
  {
    id: 'q7',
    kind: 'multi',
    prompt: '以下哪些属于 ACID 特性？（多选）',
    options: [
      { id: 'a', text: '原子性（Atomicity）' },
      { id: 'b', text: '一致性（Consistency）' },
      { id: 'c', text: '隔离性（Isolation）' },
      { id: 'd', text: '持久性（Durability）' },
    ],
    correct: ['a', 'b', 'c', 'd'],
  },
  {
    id: 'q8',
    kind: 'multi',
    prompt: '以下哪些是合法的 JSON 值类型？（多选）',
    options: [
      { id: 'a', text: '字符串' },
      { id: 'b', text: '数字' },
      { id: 'c', text: '函数' },
      { id: 'd', text: '布尔值' },
    ],
    correct: ['a', 'b', 'd'],
  },
  {
    id: 'q9',
    kind: 'multi',
    prompt: '实现操作幂等性的常见手段包括？（多选）',
    options: [
      { id: 'a', text: '为请求分配唯一操作标识' },
      { id: 'b', text: '唯一约束去重' },
      { id: 'c', text: '重复执行时直接报错并丢弃状态' },
      { id: 'd', text: '重试时返回首次执行的结果' },
    ],
    correct: ['a', 'b', 'd'],
  },
  {
    id: 'q10',
    kind: 'multi',
    prompt: '进程崩溃恢复时，以下哪些做法有助于保证账本与证书文件一致？（多选）',
    options: [
      { id: 'a', text: '清理无主的证书文件' },
      { id: 'b', text: '删除不完整的临时文件' },
      { id: 'c', text: '忽略账本直接信任磁盘文件' },
      { id: 'd', text: '以持久化账本为准核对证书' },
    ],
    correct: ['a', 'b', 'd'],
  },
];

export const EXAM_DURATION_MS = 60 * 60 * 1000;
export const COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const MAX_ATTEMPTS = 3;
export const PASS_NUMERATOR = 7;
export const PASS_DENOMINATOR = 10;
