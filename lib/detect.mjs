/**
 * 猜这段代码是什么语言。
 *
 * 用户要的是「贴代码就能跑」，所以类型不能让他选。判据按可靠性从高到低排：
 *   1. shebang（写明了就没歧义）
 *   2. Go 的结构特征（package 声明 + func main）
 *   3. Python 的结构特征（from x import / def ... / __main__）
 *   4. Node 的结构特征（require / module.exports / 箭头函数 / console.log）
 *   5. Shell 的结构特征（set -e / then / fi / done）
 * 全都不像就按 Node 算 —— 这是最不容易「一句话就报错」的默认值。
 */
export function detectLanguage(code) {
  const text = String(code ?? '')
  if (!text.trim()) return { type: 'node', ext: 'mjs', why: '空内容，按 Node 处理' }

  const shebang = (text.split('\n', 1)[0] ?? '').trim()
  if (shebang.startsWith('#!')) {
    if (/\bpython/i.test(shebang)) return { type: 'python', ext: 'py', why: 'shebang 指向 python' }
    if (/\bnode\b/i.test(shebang)) return { type: 'node', ext: 'mjs', why: 'shebang 指向 node' }
    if (/\b(ba)?sh\b/i.test(shebang)) return { type: 'bash', ext: 'sh', why: 'shebang 指向 shell' }
  }

  if (/^\s*package\s+[A-Za-z_]\w*\s*$/m.test(text) && /\bfunc\s+main\s*\(/.test(text)) {
    return { type: 'go', ext: 'go', why: '有 package 声明和 func main' }
  }
  if (/^\s*(from\s+\w+\s+import|import\s+\w+\s*$)|^\s*def\s+\w+\s*\(|^\s*if\s+__name__\s*==/m.test(text)) {
    return { type: 'python', ext: 'py', why: '是 Python 的写法' }
  }
  if (/\brequire\s*\(|\bmodule\.exports\b|^\s*export\s+(default|const|function)\b|=>|\bconsole\.(log|error)\s*\(/m.test(text)) {
    return { type: 'node', ext: 'mjs', why: '是 Node 的写法' }
  }
  if (/^\s*set\s+-[eux]|^\s*(if|while)\s+\[|\bthen\b|\bfi\b|\bdone\b/m.test(text)) {
    return { type: 'bash', ext: 'sh', why: '是 Shell 的写法' }
  }
  return { type: 'node', ext: 'mjs', why: '没看出特征，默认 Node' }
}
