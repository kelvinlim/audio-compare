/// One-sided binomial p-value for "at least `correct` successes in `n` trials"
/// under a fair coin (p = 0.5). Used as an ABX chance-level check.
pub fn binomial_pvalue(correct: u32, n: u32) -> f64 {
    if n == 0 {
        return 1.0;
    }
    if correct > n {
        return 0.0;
    }

    let mut term = 0.5_f64.powi(n as i32);
    let mut p = 0.0;
    for k in 0..=n {
        if k >= correct {
            p += term;
        }
        if k < n {
            term *= (n - k) as f64 / (k + 1) as f64;
        }
    }
    p.clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::binomial_pvalue;

    #[test]
    fn all_correct_eight_trials() {
        let p = binomial_pvalue(8, 8);
        assert!((p - 1.0 / 256.0).abs() < 1e-12);
    }

    #[test]
    fn chance_level_is_high() {
        let p = binomial_pvalue(4, 8);
        assert!(p > 0.6);
    }

    #[test]
    fn empty_session() {
        assert_eq!(binomial_pvalue(0, 0), 1.0);
    }
}
