# RatchetjqApi

All URIs are relative to *http://localhost:3000*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**claimRatchetJQJobs**](#claimratchetjqjobs) | **POST** /ratchetjq/jobs/claim | Claim RatchetJQ jobs|
|[**reportRatchetJQJob**](#reportratchetjqjob) | **POST** /ratchetjq/jobs/{jobId}/report | Report a RatchetJQ job outcome|

# **claimRatchetJQJobs**
> ClaimRatchetJQJobsResponse claimRatchetJQJobs(claimRatchetJQJobsRequest)

Long poll for the jobs this runner may run now. Returns as soon as any are available, otherwise blocks until the next job falls due, for at most 60 seconds. Claiming takes ownership: it advances the jobs it returns and moves their leases.

### Example

```typescript
import {
    RatchetjqApi,
    Configuration,
    ClaimRatchetJQJobsRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new RatchetjqApi(configuration);

let claimRatchetJQJobsRequest: ClaimRatchetJQJobsRequest; //

const { status, data } = await apiInstance.claimRatchetJQJobs(
    claimRatchetJQJobsRequest
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **claimRatchetJQJobsRequest** | **ClaimRatchetJQJobsRequest**|  | |


### Return type

**ClaimRatchetJQJobsResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**201** | The jobs this runner may run now |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **reportRatchetJQJob**
> ReportRatchetJQJobResponse reportRatchetJQJob(reportRatchetJQJobRequest)

Hand back what this runner produced for a job it claimed, or the error that stopped it. The outcome is recorded, an accept round is started for it, and the response comes as that round starts rather than when it decides — the verdict is the control plane’s to act on. A run nobody finished is still not reported: its lease is what redelivers it.

### Example

```typescript
import {
    RatchetjqApi,
    Configuration,
    ReportRatchetJQJobRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new RatchetjqApi(configuration);

let jobId: string; //ID of the claimed job the outcome belongs to (default to undefined)
let reportRatchetJQJobRequest: ReportRatchetJQJobRequest; //

const { status, data } = await apiInstance.reportRatchetJQJob(
    jobId,
    reportRatchetJQJobRequest
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **reportRatchetJQJobRequest** | **ReportRatchetJQJobRequest**|  | |
| **jobId** | [**string**] | ID of the claimed job the outcome belongs to | defaults to undefined|


### Return type

**ReportRatchetJQJobResponse**

### Authorization

[bearer](../README.md#bearer), [oauth2](../README.md#oauth2)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**201** | Whether the outcome was recorded |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

