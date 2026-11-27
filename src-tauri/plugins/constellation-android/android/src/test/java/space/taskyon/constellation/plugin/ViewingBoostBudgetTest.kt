package space.taskyon.constellation.plugin

import org.junit.Assert.assertEquals
import org.junit.Test

class ViewingBoostBudgetTest {
  @Test fun combinedViewingLeasesCannotExceedSixtySecondsPerTenMinutes() {
    val budget = ViewingBoostBudget(windowMs = 600_000L, limitMs = 60_000L)
    for (second in 0 until 60 step 10) {
      val now = second * 1_000L
      assertEquals(minOf(now + 25_000L, 60_000L), budget.permittedUntil(now, now + 25_000L, true))
    }
    assertEquals(0L, budget.permittedUntil(60_000L, 85_000L, true))
    assertEquals(0L, budget.permittedUntil(300_000L, 325_000L, true))
    assertEquals(1L, budget.permittedUntil(600_001L, 625_001L, true) - 600_001L)
  }

  @Test fun defaultBudgetAllowsTenMinutesOfAuthenticatedActiveViewing() {
    val budget = ViewingBoostBudget()
    assertEquals(25_000L, budget.permittedUntil(0L, 25_000L, true))
    assertEquals(45_000L, budget.permittedUntil(20_000L, 45_000L, true))
    assertEquals(0L, budget.permittedUntil(50_000L, 45_000L, true))
  }

  @Test fun continuousActiveViewingReturnsToSaverAfterTenMinutes() {
    val budget = ViewingBoostBudget()
    for (second in 0 until 600 step 25) {
      val now = second * 1_000L
      assertEquals(now + 25_000L, budget.permittedUntil(now, now + 25_000L, true))
    }
    assertEquals(0L, budget.permittedUntil(600_000L, 625_000L, true))
    assertEquals(0L, budget.permittedUntil(900_000L, 925_000L, true))
    assertEquals(1L, budget.permittedUntil(1_200_001L, 1_225_001L, true) - 1_200_001L)
  }

  @Test fun sourcePolicyRevokesDemandImmediately() {
    val budget = ViewingBoostBudget()
    assertEquals(25_000L, budget.permittedUntil(0L, 25_000L, true))
    assertEquals(0L, budget.permittedUntil(10_000L, 35_000L, false))
    assertEquals(40_000L, budget.permittedUntil(15_000L, 40_000L, true))
    assertEquals(0L, budget.permittedUntil(25_000L, 25_000L, true))
  }

  @Test fun absentRenewalEndsAtTheAuthenticatedLeaseDeadline() {
    val budget = ViewingBoostBudget()
    assertEquals(25_000L, budget.permittedUntil(0L, 25_000L, true))
    assertEquals(0L, budget.permittedUntil(30_000L, 25_000L, true))
  }
}
