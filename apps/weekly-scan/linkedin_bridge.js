const fs   = require('fs');
const path = require('path');

// linkedin-jobs-api may not be installed in all environments
let linkedIn;
try {
  linkedIn = require('linkedin-jobs-api');
} catch (e) {
  console.error('[linkedin_bridge] linkedin-jobs-api not installed. Run: npm install');
  fs.writeFileSync(path.join(__dirname, 'temp_linkedin_jobs.json'), '[]', 'utf-8');
  process.exit(1);
}

async function run() {
  try {
    const maxAgeDays = parseInt(process.env.POSTED_AT_MAX_AGE_DAYS || '7', 10);
    let dateSincePosted = 'past Week';
    if (maxAgeDays <= 1)  dateSincePosted = 'past 24 hours';
    else if (maxAgeDays <= 7) dateSincePosted = 'past Week';
    else dateSincePosted = 'past Month';

    const queryOptions = {
      keyword:         process.env.JOB_SEARCH_QUERY || 'backend engineer intern',
      location:        process.env.JOB_LOCATION     || 'India',
      dateSincePosted: dateSincePosted,
      jobType:         'internship',
      experienceLevel: 'internship',
      limit:           '25',
    };

    console.log('[linkedin_bridge] Querying LinkedIn:', queryOptions);
    const response = await linkedIn.query(queryOptions);

    const outputPath = path.join(__dirname, 'temp_linkedin_jobs.json');
    fs.writeFileSync(outputPath, JSON.stringify(response, null, 2), 'utf-8');
    console.log(`[linkedin_bridge] Wrote ${response.length} jobs to ${outputPath}`);
    process.exit(0);
  } catch (error) {
    console.error('[linkedin_bridge] Failed:', error.message || error);
    try {
      fs.writeFileSync(
        path.join(__dirname, 'temp_linkedin_jobs.json'),
        '[]', 'utf-8'
      );
    } catch (_) {}
    process.exit(1);
  }
}

run();
