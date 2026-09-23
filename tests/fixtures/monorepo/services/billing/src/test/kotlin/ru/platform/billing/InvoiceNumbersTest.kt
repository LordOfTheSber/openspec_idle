package ru.platform.billing

import org.junit.jupiter.api.Test

// @spec billing: Счета / Нумерация счетов
class InvoiceNumbersTest {
    @Test
    fun `Номера идут подряд`() {
        val numbers = InvoiceNumbers("INV")
        check(numbers.next() == "INV-000001")
    }
}
