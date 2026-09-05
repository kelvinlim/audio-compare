use crate::error::AppResult;
use crate::player::Source;
use crate::stats::binomial_pvalue;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionMode {
    Open,
    Blind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trial {
    pub index: u32,
    pub x_is: Source,
    pub vote: Option<Source>,
    pub correct: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub track_id: String,
    pub track_title: String,
    pub codec: String,
    pub bitrate: u32,
    pub mode: SessionMode,
    pub trial_count: u32,
    pub seed: u64,
    pub trials: Vec<Trial>,
    pub current_trial: u32,
    pub correct: u32,
    pub p_value: f64,
    pub complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub track_title: String,
    pub codec: String,
    pub bitrate: u32,
    pub mode: SessionMode,
    pub trial_count: u32,
    pub correct: u32,
    pub p_value: f64,
    pub complete: bool,
}

pub fn history_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("history.json")
}

pub fn load_history(data_dir: &Path) -> AppResult<Vec<Session>> {
    let path = history_path(data_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&raw)?)
}

pub fn save_session(data_dir: &Path, session: &Session) -> AppResult<()> {
    let mut history = load_history(data_dir)?;
    if let Some(existing) = history.iter_mut().find(|item| item.id == session.id) {
        *existing = session.clone();
    } else {
        history.insert(0, session.clone());
    }
    std::fs::create_dir_all(data_dir)?;
    std::fs::write(history_path(data_dir), serde_json::to_string_pretty(&history)?)?;
    Ok(())
}

pub fn start_session(
    track_id: String,
    track_title: String,
    codec: String,
    bitrate: u32,
    mode: SessionMode,
    trial_count: u32,
) -> Session {
    let seed = rand::random::<u64>();
    let mut rng = <rand::rngs::StdRng as rand::SeedableRng>::seed_from_u64(seed);
    let count = if mode == SessionMode::Open {
        0
    } else {
        trial_count.max(1)
    };
    let trials = (0..count)
        .map(|index| Trial {
            index,
            x_is: if rand::Rng::gen::<bool>(&mut rng) {
                Source::A
            } else {
                Source::B
            },
            vote: None,
            correct: None,
        })
        .collect();

    Session {
        id: uuid::Uuid::new_v4().to_string(),
        started_at: chrono::Utc::now().to_rfc3339(),
        finished_at: None,
        track_id,
        track_title,
        codec,
        bitrate,
        mode,
        trial_count: count,
        seed,
        trials,
        current_trial: 0,
        correct: 0,
        p_value: 1.0,
        complete: mode == SessionMode::Open,
    }
}

pub fn vote(session: &mut Session, choice: Source) -> AppResult<Session> {
    if session.mode != SessionMode::Blind {
        return Ok(session.clone());
    }
    if session.complete {
        return Ok(session.clone());
    }
    let index = session.current_trial as usize;
    let Some(trial) = session.trials.get_mut(index) else {
        session.complete = true;
        return Ok(session.clone());
    };
    let correct = choice == trial.x_is;
    trial.vote = Some(choice);
    trial.correct = Some(correct);
    if correct {
        session.correct += 1;
    }
    session.current_trial += 1;
    let answered = session.current_trial;
    session.p_value = binomial_pvalue(session.correct, answered);
    if session.current_trial >= session.trial_count {
        session.complete = true;
        session.finished_at = Some(chrono::Utc::now().to_rfc3339());
    }
    Ok(session.clone())
}

pub fn current_x(session: &Session) -> Option<Source> {
    session
        .trials
        .get(session.current_trial as usize)
        .map(|trial| trial.x_is)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blind_session_scores_votes() {
        let mut session = start_session(
            "id".into(),
            "Track".into(),
            "mp3".into(),
            128,
            SessionMode::Blind,
            4,
        );
        assert_eq!(session.trials.len(), 4);
        let first = session.trials[0].x_is;
        let updated = vote(&mut session, first).unwrap();
        assert_eq!(updated.correct, 1);
        assert_eq!(updated.current_trial, 1);
        assert!(!updated.complete);
    }
}

pub fn summaries(sessions: &[Session]) -> Vec<SessionSummary> {
    sessions
        .iter()
        .map(|session| SessionSummary {
            id: session.id.clone(),
            started_at: session.started_at.clone(),
            finished_at: session.finished_at.clone(),
            track_title: session.track_title.clone(),
            codec: session.codec.clone(),
            bitrate: session.bitrate,
            mode: session.mode.clone(),
            trial_count: session.trial_count,
            correct: session.correct,
            p_value: session.p_value,
            complete: session.complete,
        })
        .collect()
}
