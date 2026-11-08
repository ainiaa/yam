// Author: Jeff.Liu. Explicit original-session input, with a preview and no Enter key.
import {useEffect,useRef,useState} from 'react';
import {t} from './i18n';
import {
  combineReviewComments,emptyReviewDraft,formatReviewFeedback,loadReviewDraft,sameReviewOrigin,saveReviewDraft,
  type ReviewDraft,type ReviewLocation,type ReviewLocationStatus,type ReviewOrigin,type ReviewStorage,
} from './review-feedback';

type Props = {
  active: boolean;
  origin: ReviewOrigin | null;
  ready: boolean;
  location: ReviewLocation | null;
  locationRevision?: number | null;
  storage?: ReviewStorage;
  onCheck: (origin: ReviewOrigin, locations: ReviewLocation[], stillCurrent: () => boolean) => Promise<ReviewLocationStatus[]>;
  onFill: (origin: ReviewOrigin, location: ReviewLocation, text: string, locations: ReviewLocation[]) => Promise<void>;
};

export function ReviewFeedback({active,origin,ready,location,locationRevision,storage,onCheck,onFill}: Props) {
  const mounted = useRef(false), flight = useRef(false);
  const field = useRef<HTMLTextAreaElement | null>(null), seen = useRef<ReviewLocation | null>(null);
  const [{draft,problem},setStored] = useState(() => loadReviewDraft(storage));
  const [busy,setBusy] = useState(false), [message,setMessage] = useState<string | null>(null);
  const [filled,setFilled] = useState<string | null>(null);
  const [discard,setDiscard] = useState(false);
  const [revision,setRevision] = useState(0);
  const [checked,setChecked] = useState<{key:string;statuses:ReviewLocationStatus[]} | null>(null);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  useEffect(() => {
    if (!active || !location || seen.current === location) return;
    seen.current = location;
    field.current?.scrollIntoView({block:'nearest'});
    field.current?.focus();
  }, [location,active]);

  const {comments} = draft;
  const same = sameReviewOrigin(draft.origin,origin);
  const currentLocation = location && origin && location.sessionId === origin.sessionId ? location : null;
  const target = draft.text.trim() ? draft.location ?? comments[0]?.location : comments[0]?.location ?? draft.location;
  const locations = [...comments.map(comment => comment.location), ...(target && draft.text.trim() ? [target] : [])];
  const roundRevision = locations.some(point => point.basis === 'round') ? locationRevision : undefined;
  const checkKey = active && same && locations.length && roundRevision !== null ? JSON.stringify([draft.origin, locations, revision, roundRevision]) : '';
  const activeCheck = useRef(checkKey);
  activeCheck.current = checkKey;
  useEffect(() => {
    setChecked(null);
    if (!checkKey || !draft.origin) return;
    let cancelled = false;
    const current = () => !cancelled && activeCheck.current === checkKey;
    const complete = (statuses:ReviewLocationStatus[]) => {if (current()) setChecked({key:checkKey,statuses});};
    void onCheck(draft.origin, locations, current).then(complete, () => complete(locations.map(() => 'unavailable')));
    return () => {cancelled = true;};
  }, [checkKey,onCheck]);
  const statuses = checked?.key === checkKey ? checked.statuses : null;

  function save(next: ReviewDraft, reset = false) {
    if (flight.current) return;
    let nextProblem = problem;
    if (problem !== 'corrupt' || reset) {
      try {
        saveReviewDraft(next, storage);
        nextProblem = null;
      } catch {
        if (reset) {
          setMessage('Could not discard saved feedback. The batch was kept.');
          return;
        }
        nextProblem = problem === 'corrupt' ? 'corrupt' : 'unavailable';
      }
    }
    setStored({draft:next,problem:nextProblem});
    setFilled(null);
    setMessage(null);
    setDiscard(false);
  }

  let preview: string | null = null, body = draft.text, canAdd = false;
  if (draft.origin && target) {
    try {
      if (comments.length) body = combineReviewComments(draft.origin, [...comments, ...(draft.text.trim() ? [{location:target,text:draft.text}] : [])]);
      preview = formatReviewFeedback(draft.origin,target,body);
      if (draft.text.trim() && comments.length < 20) {
        combineReviewComments(draft.origin, [...comments,{location:target,text:draft.text}]);
        canAdd = true;
      }
    } catch { /* Invalid or incomplete drafts remain editable. */ }
  }
  const canFill = !!preview && same && ready && !busy && filled !== preview
    && statuses?.length === locations.length && statuses.every(status => status === 'current');
  async function fill() {
    if (!canFill || flight.current || !draft.origin || !target) return;
    flight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await onFill(draft.origin,target,body,locations);
      if (mounted.current) {
        setFilled(preview);
        setMessage('Feedback was filled into the original CLI. Check the input and press Enter there to submit.');
      }
    } catch (reason) {
      if (!mounted.current) return;
      if (reason === 'review_location_stale' || reason === 'review_location_unavailable') {
        setRevision(value => value + 1);
        setMessage(reason === 'review_location_stale' ? 'A diff location changed. Nothing was filled.' : 'A diff location could not be verified. Nothing was filled.');
      } else if (reason === 'review_target_unavailable') {
        setMessage('The original CLI cannot receive this feedback now. Nothing was filled.');
      } else if (reason === 'review_invalid_feedback') {
        setMessage('Choose a diff location and use up to 16 KiB of text without terminal controls.');
      } else {
        setMessage('Delivery could not be confirmed. Check the original terminal before retrying.');
      }
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function locationDetails(point: ReviewLocation, status?: ReviewLocationStatus) {
    return <>
      <strong>{point.path} · {point.basis} · {point.side} · {point.line ?? t('Whole file')}</strong>
      {point.anchor && <p><code>{point.anchor.context}</code></p>}
      {status === 'stale' && <p role="status">{t('Original diff location is stale. Select a new location to use this comment.')}</p>}
      {status === 'unavailable' && <p role="status">{t('Could not verify this diff location. Check again before filling.')}</p>}
    </>;
  }
  if (!active) return null;
  return <section className="review-feedback" aria-label={t('Review feedback')}>
    <h3>{t('Review feedback')}</h3>
    <p>{t('This review batch is saved on this device. Record a fresh baseline to compare the next round separately.')}</p>
    {problem && <p role="alert">{t(problem === 'corrupt'
      ? 'Saved feedback could not be read. It is kept until you explicitly discard the batch.'
      : 'Feedback could not be saved. The current edits are available in this window.')}</p>}
    {draft.origin && <p>{t('Original native session')}: <code>{draft.origin.nativeSessionId}</code></p>}
    {!same && (draft.text || comments.length > 0) && <p role="status">{t('The native target changed or is not bound. The draft is kept; binding requires an explicit action.')}</p>}
    {!ready && <p role="status">{t('Filling requires a connected, idle native CLI in the selected local session.')}</p>}
    <div className="project-files-controls">
      {origin && !same && <button type="button" disabled={busy || comments.length > 0} onClick={() => save({...draft,origin,location:currentLocation})}>{t('Bind current native session')}</button>}
      {currentLocation && <button type="button" disabled={busy || !same} onClick={() => save({...draft,location:currentLocation})}>{t('Use selected diff location')}</button>}
      <button type="button" disabled={busy} onClick={() => {
        if (draft.text || comments.length || problem === 'corrupt') setDiscard(true);
        else save({...emptyReviewDraft(),origin,location:currentLocation});
      }}>{t('New feedback')}</button>
      {discard && <>
        <button type="button" disabled={busy} onClick={() => save({...emptyReviewDraft(),origin,location:currentLocation},true)}>{t('Discard saved review batch')}</button>
        <button type="button" onClick={() => setDiscard(false)}>{t('Keep review batch')}</button>
      </>}
      {!!checkKey && <button type="button" disabled={busy || !statuses} onClick={() => setRevision(value => value + 1)}>{t('Check review locations')}</button>}
    </div>
    {checkKey && !statuses && <p role="status">{t('Checking original diff locations…')}</p>}
    {draft.location && locationDetails(draft.location, draft.text.trim() ? statuses?.[comments.length] : undefined)}
    <textarea ref={field} aria-label={t('Review comment')} rows={5} maxLength={16384} disabled={busy} value={draft.text} onChange={event => {
      const bound = draft.origin ?? origin;
      save({...draft,text:event.target.value,origin:bound,location:draft.location ?? (sameReviewOrigin(bound,origin) ? currentLocation : null)});
    }}/>
    <div className="project-files-controls">
      <button type="button" disabled={busy || !same || !canAdd} onClick={() => {
        if (canAdd && target) save({...draft,text:'',comments:[...comments,{location:target,text:draft.text}]});
      }}>{t('Add comment')}</button>
      <span>{comments.length} / 20 {t('Saved review comments')}</span>
    </div>
    {((draft.text && !canAdd) || (comments.length > 0 && !preview)) && <p role="status">{t('Choose a diff location and keep comments within 16 KiB total, including file context.')}</p>}
    {!same && comments.length > 0 && <p role="status">{t('Queued comments stay bound to their original session. Return to that session, or remove the queued comments before rebinding.')}</p>}
    {comments.length > 0 && <ol>{comments.map((item,index) => <li key={index}>
      {locationDetails(item.location,statuses?.[index])}<p>{item.text}</p>
      {same && currentLocation && statuses?.[index] === 'stale' && <button type="button" disabled={busy} onClick={() => {
        save({...draft,comments:comments.map((comment,i) => i === index ? {...comment,location:currentLocation} : comment)});
      }}>{t('Relocate comment to selected diff location')}</button>}
      <button type="button" disabled={busy} onClick={() => save({...draft,comments:comments.filter((_,i) => i !== index)})}>{t('Remove comment')}</button>
    </li>)}</ol>}
    {preview && <details><summary>{t('Preview exact CLI input')}</summary><pre>{preview}</pre></details>}
    <button type="button" disabled={!canFill} onClick={() => void fill()}>{busy ? t('Filling…') : t('Fill original CLI input')}</button>
    {message && <p role="status">{t(message)}</p>}
  </section>;
}
