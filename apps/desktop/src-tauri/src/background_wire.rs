use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

pub(super) fn read_frame(stream: &mut TcpStream, limit: usize) -> Result<Vec<u8>, String> {
    read_frame_with_budget(stream, limit, Duration::from_secs(3))
}

pub(super) fn read_frame_with_budget(
    stream: &mut TcpStream,
    limit: usize,
    budget: Duration,
) -> Result<Vec<u8>, String> {
    // Winsock accepts inherit the nonblocking listener mode; timeout-based framing requires blocking I/O.
    stream
        .set_nonblocking(false)
        .map_err(|_| "Cannot configure background frame mode")?;
    let deadline = Instant::now() + budget;
    let mut read = |mut bytes: &mut [u8]| -> Result<(), String> {
        while !bytes.is_empty() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("Background frame timed out".into());
            }
            stream
                .set_read_timeout(Some(remaining))
                .map_err(|_| "Cannot bound background frame")?;
            match stream.read(bytes) {
                Ok(0) => return Err("Incomplete background frame".into()),
                Ok(size) => bytes = &mut bytes[size..],
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Err("Background frame unavailable or timed out".into()),
            }
        }
        Ok(())
    };
    let mut length = [0u8; 4];
    read(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > limit {
        return Err("Background frame exceeds size budget".into());
    }
    let mut bytes = vec![0; length];
    read(&mut bytes)?;
    Ok(bytes)
}

pub(super) fn write_frame(
    stream: &mut TcpStream,
    bytes: &[u8],
    limit: usize,
) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > limit {
        return Err("Background frame exceeds size budget".into());
    }
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .and_then(|_| stream.write_all(bytes))
        .map_err(|_| "Cannot send background frame".into())
}
