# 依赖升级指南

## 问题说明

Docker 构建时出现的 npm 弃用警告来自过时的开发依赖项。

## 快速解决（推荐）

### 方案 1: 升级 ESLint 和开发工具

```bash
# 1. 升级到 ESLint 9 和相关插件
npm install -D eslint@^9.0.0 \
  @typescript-eslint/eslint-plugin@^8.0.0 \
  @typescript-eslint/parser@^8.0.0

# 2. 创建新的 ESLint 配置（ESLint 9 使用 flat config）
cat > eslint.config.js << 'EOF'
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];
EOF

# 3. 删除旧配置（如果存在）
rm -f .eslintrc.js .eslintrc.json .eslintrc.yml

# 4. 清理并重新安装
rm -rf node_modules package-lock.json
npm install
```

### 方案 2: 最小化升级（保留 ESLint 8）

如果不想改动太多，只升级其他工具：

```bash
npm install -D \
  prettier@^3.4.0 \
  vitest@^2.0.0 \
  @vitest/ui@^2.0.0 \
  tsx@^4.19.0
```

### 方案 3: 忽略警告（临时）

如果暂时不想升级，在 `package.json` 添加：

```json
{
  "scripts": {
    "build": "tsc",
    "postinstall": "echo '⚠️  开发依赖有弃用警告，但不影响生产环境'"
  }
}
```

## 验证升级

```bash
# 检查是否还有弃用警告
npm install --legacy-peer-deps 2>&1 | grep "deprecated"

# 测试构建
npm run build

# 测试 lint
npm run lint

# 测试开发服务器
npm run dev
```

## Docker 构建优化

在 `Dockerfile` 中添加 npm 日志级别控制：

```dockerfile
# 构建阶段减少日志
RUN npm ci --loglevel=error
```

或使用 `.npmrc` 配置：

```bash
cat > .npmrc << 'EOF'
loglevel=error
audit=false
fund=false
EOF
```

## 当前状态对比

| 依赖 | 当前版本 | 推荐版本 | 优先级 |
|------|---------|---------|-------|
| eslint | 8.56.0 | 9.18.0 | 🔴 高 |
| @typescript-eslint/eslint-plugin | 6.19.0 | 8.18.2 | 🔴 高 |
| @typescript-eslint/parser | 6.19.0 | 8.18.2 | 🔴 高 |
| prettier | 3.2.4 | 3.4.2 | 🟡 中 |
| vitest | 1.2.0 | 2.1.8 | 🟡 中 |
| tsx | 4.7.0 | 4.19.2 | 🟢 低 |

## 升级影响评估

- **ESLint 9**: 配置格式从 `.eslintrc.*` 改为 `eslint.config.js` (flat config)
- **TypeScript ESLint 8**: 与 ESLint 9 兼容，规则无变化
- **Vitest 2**: API 向后兼容，性能提升
- **其他工具**: 向后兼容

## 推荐执行顺序

1. ✅ **现在**：先完成 Docker 部署（警告不影响生产）
2. 🔧 **本周**：升级 ESLint 和 TypeScript ESLint（方案 1）
3. 📦 **下次迭代**：升级其他开发工具（方案 2）

## 注意事项

- 所有弃用警告都来自 **devDependencies**（开发依赖）
- 生产环境的 Docker 镜像 **不包含** 这些依赖
- 升级后需要运行完整测试套件验证兼容性
