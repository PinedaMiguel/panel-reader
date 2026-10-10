import { useHeart } from './heart'

// The heart bar shown while reading with the heart meter on.
export default function HeartMeter({ comicId }: { comicId: string }) {
  const { score, trend, status } = useHeart(comicId, true)
  const label =
    status === 'starting' ? 'Starting camera…'
    : status === 'denied' ? 'Camera unavailable'
    : status === 'no-face' ? 'Looking for your face…'
    : `${Math.round(score)}%`
  return (
    <div
      className={`heart-meter${trend > 0 ? ' up' : trend < 0 ? ' down' : ''}`}
      role="meter"
      aria-label="How much you're enjoying this comic"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(score)}
      title="Fills when you smile or look wide-eyed, drains when you frown. Measured on this device only."
    >
      <span className="heart-icon" aria-hidden="true">♥</span>
      <span className="heart-bar" aria-hidden="true">
        <span style={{ width: `${score}%` }} />
      </span>
      <span className="heart-label">{label}</span>
    </div>
  )
}
