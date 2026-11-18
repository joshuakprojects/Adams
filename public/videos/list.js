/* The how-to videos (made from the demo app: sample customers only). Used by the app's ▶ Videos button,
   the public videos page (/videos/) and the staff guide. `pages`: where the app lists the video first. */
window.AB_VIDEOS = [
  { slug: 'book-a-call', title: 'Book a phone call', who: 'Reception', secs: 66, pages: ['reception'] },
  { slug: 'change-cancel', title: 'Change or cancel a booking', who: 'Reception', secs: 35, pages: ['reception'] },
  { slug: 'new-job', title: 'Make a work order and text the driver', who: 'Dispatch', secs: 48, pages: ['board'] },
  { slug: 'route', title: 'Plan the septic route', who: 'Dispatch', secs: 36, pages: ['board'] },
  { slug: 'our-sites', title: 'Our sites: hand out trucks and machines', who: 'Dispatch & office', secs: 48, pages: ['sites', 'reception'] },
  { slug: 'driver', title: 'For drivers: your text and your job page', who: 'Drivers', secs: 37, pages: ['driver'], phone: true },
  { slug: 'snow-call', title: 'Start a snow call', who: 'Overnight', secs: 50, pages: ['snow'] },
  { slug: 'shovelers', title: 'Add shovelers and send the setup text', who: 'Overnight', secs: 43, pages: ['snow'] },
];
window.AB_VIDEO_LEN = (s) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60 ? (s % 60) + ' s' : ''}`.trim());
