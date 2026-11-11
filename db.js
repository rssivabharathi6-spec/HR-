const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const db = new Database(process.env.DB_FILE || path.join(__dirname, 'hr.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return false;
  const hash = p => bcrypt.hashSync(p, 10);
  const tx = db.transaction(() => {
    ['Engineering', 'Sales', 'Support', 'HR', 'Finance'].forEach(n =>
      db.prepare('INSERT INTO departments(name) VALUES (?)').run(n));
    const dep = n => db.prepare('SELECT id FROM departments WHERE name=?').get(n).id;
    const addUser = db.prepare(`INSERT INTO users
      (email,password_hash,name,role,department_id,manager_id,job_title,join_date,salary_lakh,market_salary_lakh,last_promotion_date)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    // Demo logins. CHANGE THESE PASSWORDS before real use.
    const hr = addUser.run('hr@company.com', hash('hr123'), 'Asha Menon', 'HR', dep('HR'), null, 'HR Head', '2019-04-01', 18, 18, '2022-04-01').lastInsertRowid;
    const mg = addUser.run('manager@company.com', hash('mgr123'), 'Ravi Kumar', 'Manager', dep('Engineering'), hr, 'Engineering Manager', '2018-07-15', 24, 25, '2023-01-01').lastInsertRowid;
    const emps = [
      ['employee@company.com', 'Ananya R.', 'Data Analyst', 'Engineering', '2021-03-10', 8, 9.1, '2023-09-01'],
      ['karthik@company.com', 'Karthik M.', 'Sr. Developer', 'Engineering', '2020-06-01', 16, 16.5, '2024-04-01'],
      ['divya@company.com', 'Divya S.', 'HR Executive', 'HR', '2022-01-20', 6, 6.4, '2024-01-01'],
      ['vikram@company.com', 'Vikram P.', 'Sales Lead', 'Sales', '2020-11-05', 12, 12.5, '2023-06-01'],
      ['meera@company.com', 'Meera K.', 'Designer', 'Support', '2023-02-14', 7, 7, '2026-06-01'],
    ];
    const ids = emps.map(e => addUser.run(e[0], hash('emp123'), e[1], 'Employee', dep(e[3]), mg, e[2], e[4], e[5], e[6], e[7]).lastInsertRowid);
    const all = [hr, mg, ...ids];
    all.forEach(u => [['Casual', 8], ['Sick', 5], ['Earned', 12]].forEach(([t, d]) =>
      db.prepare('INSERT INTO leave_balances VALUES (?,?,?)').run(u, t, d)));
    db.prepare('INSERT INTO leave_requests(user_id,type,days,reason) VALUES (?,?,?,?)').run(ids[1], 'Casual', 2, 'Family event');
    [['Close 20 hires', 70], ['Cut time-to-fill to 28 days', 45], ['Launch buddy programme', 90]]
      .forEach(([t, p]) => db.prepare('INSERT INTO goals(user_id,title,progress) VALUES (?,?,?)').run(hr, t, p));
    [['Rahul T.', 'Backend Dev', 'Screened'], ['Priya N.', 'UI Designer', 'Applied'], ['Suresh K.', 'Sales Lead', 'Interview'],
     ['Aditya C.', 'Sr. Developer', 'Offer'], ['Sneha L.', 'Recruiter', 'Hired']]
      .forEach(c => db.prepare('INSERT INTO candidates(name,role,stage) VALUES (?,?,?)').run(...c));
    ['Documents', 'IT setup', 'Buddy meet', 'Policy sign-off', '30-day check-in']
      .forEach((s, i) => db.prepare('INSERT INTO onboarding_tasks(user_id,step,done) VALUES (?,?,?)').run(ids[4], s, i < 2 ? 1 : 0));
    ['Code of Conduct', 'Remote Work Policy', 'Data Privacy Policy']
      .forEach(t => db.prepare('INSERT INTO policies(title) VALUES (?)').run(t));
    [['POSH annual training', 92, '2026-11-30'], ['PF/ESI filing', 100, '2026-11-15'], ['DPDP consent records', 76, '2026-12-15']]
      .forEach(c => db.prepare('INSERT INTO compliance_items(title,percent_done,due_date) VALUES (?,?,?)').run(...c));
    const moods = { Engineering: [3, 3, 2, 3], Sales: [3, 2, 3, 3], Support: [1, 2, 1, 2], HR: [3, 4, 3, 3], Finance: [3, 3, 4, 3] };
    Object.entries(moods).forEach(([d, ms]) => ms.forEach(m =>
      db.prepare('INSERT INTO pulse_responses(department_id,mood,week) VALUES (?,?,?)').run(dep(d), m, '2026-W45')));
    // Two past employees so attrition and time-to-fill have data
    const ex = addUser.run('ex1@company.com', hash('disabled'), 'Former Employee A', 'Employee', dep('Sales'), mg, 'Sales Exec', '2021-01-01', 7, 8, null).lastInsertRowid;
    const ex2 = addUser.run('ex2@company.com', hash('disabled'), 'Former Employee B', 'Employee', dep('Support'), mg, 'Support Exec', '2022-01-01', 5, 6, null).lastInsertRowid;
    db.prepare('UPDATE users SET active=0 WHERE id IN (?,?)').run(ex, ex2);
    db.prepare('INSERT INTO exits(user_id,exit_date,reason) VALUES (?,?,?)').run(ex, '2026-08-15', 'Better pay');
    db.prepare('INSERT INTO exits(user_id,exit_date,reason) VALUES (?,?,?)').run(ex2, '2026-09-30', 'Career growth');
    db.prepare("UPDATE candidates SET applied_on=date('now','-30 days'), hired_on=date('now','-2 days') WHERE stage='Hired'").run();
  });
  tx();
  return true;
}
module.exports = { db, seed };
if (require.main === module) console.log(seed() ? 'Database created and seeded.' : 'Database already has data.');
