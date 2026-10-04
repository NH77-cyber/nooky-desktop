// Weather for the reduced island text: Open-Meteo (free, no key).
// The city comes from the settings; nothing about it is stored in the code.
// Nooky Desktop — original code.

use std::time::Duration;

use serde_json::{json, Value};

/// City name -> `{"temp": 14, "code": 61, "rain": 60}` (rain = highest chance in the next 12 hours).
#[tauri::command]
pub async fn weather_get(city: String) -> Result<String, String> {
    let city = city.trim().to_string();
    if city.is_empty() || city.chars().count() > 80 {
        return Err("ville invalide".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let geo: Value = client
        .get("https://geocoding-api.open-meteo.com/v1/search")
        .query(&[("name", city.as_str()), ("count", "1"), ("language", "fr")])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let first = geo["results"].get(0).ok_or_else(|| "ville introuvable".to_string())?;
    let lat = first["latitude"].as_f64().ok_or_else(|| "ville introuvable".to_string())?;
    let lon = first["longitude"].as_f64().ok_or_else(|| "ville introuvable".to_string())?;

    let lat_s = lat.to_string();
    let lon_s = lon.to_string();
    let fc: Value = client
        .get("https://api.open-meteo.com/v1/forecast")
        .query(&[
            ("latitude", lat_s.as_str()),
            ("longitude", lon_s.as_str()),
            ("current", "temperature_2m,weather_code"),
            ("hourly", "precipitation_probability"),
            ("forecast_hours", "12"),
            ("timezone", "auto"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let temp = fc["current"]["temperature_2m"].as_f64().ok_or_else(|| "météo indisponible".to_string())?;
    let code = fc["current"]["weather_code"].as_i64().unwrap_or(0);
    let rain = fc["hourly"]["precipitation_probability"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_f64).fold(0.0_f64, f64::max))
        .unwrap_or(0.0);
    Ok(json!({ "temp": temp.round() as i64, "code": code, "rain": rain.round() as i64 }).to_string())
}
