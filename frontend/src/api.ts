export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const { headers, ...rest } = init ?? {}
  const res = await fetch(url, {
    ...rest,
    // 合并而非覆盖：调用方自定义头（如 x-user-token）与默认 Content-Type 共存
    headers: { 'Content-Type': 'application/json', ...(headers as Record<string, string> | undefined) },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error((data as { message?: string }).message || `请求失败（${res.status}）`)
  }
  return data as T
}
