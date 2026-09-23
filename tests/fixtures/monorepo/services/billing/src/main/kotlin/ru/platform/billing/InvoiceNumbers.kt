package ru.platform.billing

// @spec billing: Счета / Нумерация счетов
class InvoiceNumbers(private val prefix: String) {
    private var counter = 0L

    fun next(): String {
        counter += 1
        return "%s-%06d".format(prefix, counter)
    }
}
