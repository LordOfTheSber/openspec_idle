package ru.platform.billing

import ru.platform.km.core.ResponseCache

/* @spec billing: Возвраты / Полный возврат */
class Refunds(private val cache: ResponseCache) {
    // @spec km/core: Кэш ответов
    fun refund(invoice: String): Boolean = cache.invalidate(invoice)
}
