import {test} from 'node:test';
import assert from 'node:assert/strict';
import {emptyCourse,parseCourse,editCourse} from '@/lib/course';
test('the integrated parser and certificate editor preserve the independent default-off video stamp',()=>{
 for(const stampVideo of [undefined,false,true,'true',1,null])for(const certificateMonths of [undefined,1,12,120]){
  const course=parseCourse(JSON.stringify({...emptyCourse(),stampVideo,certificateMonths}));assert.ok(course);
  assert.equal(course.stampVideo,stampVideo===true?true:undefined);assert.equal(course.certificateMonths,certificateMonths);
  const changed=editCourse(course,{op:'certificate-months',months:24});assert.ok(changed.ok);
  assert.equal(changed.course.stampVideo,stampVideo===true?true:undefined);assert.equal(parseCourse(JSON.stringify(changed.course))?.certificateMonths,24);
 }
});
