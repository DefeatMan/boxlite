# RatchetjqApi

All URIs are relative to *http://localhost*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**syncRatchetJob**](#syncratchetjob) | **POST** /ratchetjq/jobs/sync | Run a RatchetJQ job synchronously|

# **syncRatchetJob**
> SyncRatchetJobResponseDTO syncRatchetJob(job)

Instantiate the executor registered for the job type and run it inline, returning its outParams — or status \"failed\" with errMsg when the run raised

### Example

```typescript
import {
    RatchetjqApi,
    Configuration,
    SyncRatchetJobDTO
} from './api';

const configuration = new Configuration();
const apiInstance = new RatchetjqApi(configuration);

let job: SyncRatchetJobDTO; //Job to run

const { status, data } = await apiInstance.syncRatchetJob(
    job
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **job** | **SyncRatchetJobDTO**| Job to run | |


### Return type

**SyncRatchetJobResponseDTO**

### Authorization

[Bearer](../README.md#Bearer)

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | OK |  -  |
|**400** | Bad Request |  -  |
|**401** | Unauthorized |  -  |
|**409** | Conflict |  -  |
|**500** | Internal Server Error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

