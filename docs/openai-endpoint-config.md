# OpenAI API 端点配置指南

本项目支持自定义 OpenAI API 端点，可以使用以下任何兼容的服务：

## 配置方法

在 `.env` 文件中设置 `OPENAI_BASE_URL` 环境变量：

```bash
OPENAI_BASE_URL=https://your-custom-endpoint.com/v1
```

如果不设置，默认使用官方 OpenAI API：`https://api.openai.com/v1`

---

## 支持的服务

### 1. OpenAI 官方 API（默认）

```bash
OPENAI_API_KEY=sk-proj-your-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o
```

**优点**：
- 官方服务，稳定可靠
- 模型更新及时
- 完整的功能支持

**缺点**：
- 国内需要代理
- 相对较贵

---

### 2. Azure OpenAI

```bash
OPENAI_API_KEY=your-azure-api-key
OPENAI_BASE_URL=https://your-resource.openai.azure.com/openai/deployments/your-deployment
OPENAI_MODEL=gpt-4o
```

**优点**：
- 国内可直接访问
- 企业级 SLA
- 数据隐私保护

**缺点**：
- 需要 Azure 订阅
- 配置相对复杂

**注意**：Azure OpenAI 的 URL 格式与标准 OpenAI 不同，需要包含资源名称和部署名称。

---

### 3. 第三方代理/中转服务

```bash
OPENAI_API_KEY=your-proxy-api-key
OPENAI_BASE_URL=https://api.your-proxy.com/v1
OPENAI_MODEL=gpt-4o
```

**常见代理服务**：
- OpenAI 中转 API
- Cloudflare Workers 代理
- 自建反向代理

**优点**：
- 解决网络访问问题
- 可能提供更优惠的价格
- 支持多种支付方式

**缺点**：
- 稳定性取决于代理服务商
- 可能存在数据安全风险

---

### 4. 本地 LLM 服务

#### LocalAI

```bash
OPENAI_API_KEY=not-needed
OPENAI_BASE_URL=http://localhost:8080/v1
OPENAI_MODEL=your-local-model
```

#### vLLM

```bash
OPENAI_API_KEY=not-needed
OPENAI_BASE_URL=http://localhost:8000/v1
OPENAI_MODEL=your-model-name
```

#### Ollama（需要 OpenAI 兼容层）

```bash
OPENAI_API_KEY=not-needed
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL=llama3
```

**优点**：
- 完全免费
- 数据本地化
- 无网络依赖

**缺点**：
- 翻译质量可能不如 GPT-4o
- 需要本地 GPU 资源
- 翻译速度较慢

---

### 5. 其他 OpenAI 兼容服务

#### DeepSeek

```bash
OPENAI_API_KEY=your-deepseek-key
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_MODEL=deepseek-chat
```

#### Moonshot AI (Kimi)

```bash
OPENAI_API_KEY=your-moonshot-key
OPENAI_BASE_URL=https://api.moonshot.cn/v1
OPENAI_MODEL=moonshot-v1-8k
```

#### 智谱 AI (GLM)

```bash
OPENAI_API_KEY=your-zhipu-key
OPENAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4
OPENAI_MODEL=glm-4
```

---

## 验证配置

启动服务器后，检查日志确认配置是否正确：

```bash
npm run dev
```

**正常输出**：
```
[Config] Application configuration loaded:
{
  "openai": {
    "apiKey": "***key",
    "baseUrl": "https://your-custom-endpoint.com/v1",
    "model": "gpt-4o",
    "timeout": 20000
  }
}
```

---

## 故障排查

### 问题 1：连接超时

**症状**：`Translation failed: timeout`

**解决方案**：
1. 检查网络连接
2. 确认端点 URL 正确
3. 增加超时时间：`TRANSLATE_TIMEOUT_MS=30000`

---

### 问题 2：认证失败

**症状**：`401 Unauthorized` 或 `403 Forbidden`

**解决方案**：
1. 确认 API key 正确
2. 检查 API key 权限
3. 对于 Azure OpenAI，确认 URL 格式正确

---

### 问题 3：模型不存在

**症状**：`Model not found` 或 `Invalid model`

**解决方案**：
1. 确认模型名称正确
2. 检查服务是否支持该模型
3. 查看服务商的模型列表文档

---

### 问题 4：响应格式不兼容

**症状**：`Invalid response format`

**解决方案**：
1. 确认服务是否完全兼容 OpenAI API
2. 检查返回的 JSON 格式
3. 考虑使用官方 OpenAI 或更兼容的服务

---

## 成本优化建议

### 1. 使用更便宜的模型

```bash
# GPT-4o mini (更便宜，质量略低)
OPENAI_MODEL=gpt-4o-mini

# GPT-3.5 Turbo (最便宜，质量较低)
OPENAI_MODEL=gpt-3.5-turbo
```

### 2. 调整并发数

```bash
# 减少并发翻译任务，降低峰值成本
QUEUE_CONCURRENCY=1
```

### 3. 增加缓存时间

```bash
# 延长缓存有效期，减少重复翻译
CACHE_TTL_HOURS=2160  # 90 天
```

---

## 推荐配置

### 个人使用（成本优先）

```bash
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_MODEL=deepseek-chat
QUEUE_CONCURRENCY=1
CACHE_TTL_HOURS=2160
```

### 企业使用（质量优先）

```bash
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o
QUEUE_CONCURRENCY=2
CACHE_TTL_HOURS=720
```

### 离线使用（本地部署）

```bash
OPENAI_BASE_URL=http://localhost:8080/v1
OPENAI_MODEL=llama3-chinese
QUEUE_CONCURRENCY=1
TRANSLATE_TIMEOUT_MS=60000
```

---

## 注意事项

1. **API 兼容性**：并非所有声称兼容 OpenAI 的服务都完全兼容，可能需要调整代码
2. **数据安全**：使用第三方服务时注意数据隐私
3. **服务稳定性**：建议使用可靠的服务商，避免频繁切换
4. **成本监控**：定期检查 API 使用量和费用

---

## 参考文档

- [OpenAI API 文档](https://platform.openai.com/docs/api-reference)
- [Azure OpenAI 文档](https://learn.microsoft.com/en-us/azure/ai-services/openai/)
- [LocalAI 文档](https://localai.io/)
- [vLLM 文档](https://docs.vllm.ai/)
